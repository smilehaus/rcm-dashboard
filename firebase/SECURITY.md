# Locking the live board

The dashboard is public on GitHub Pages. Do not paste the rules until an editor has unlocked the board once. Nothing here is applied automatically.

Editor PINs and the role records live in Cloudflare KV, not in this repo.

## Who can edit

Editing is unlocked with a staff PIN. A Cloudflare Worker checks that PIN against a hash it stores with the person's role. The page never decides this by itself.

A stored role can edit when it is RCM manager, REACH manager, office manager, operations manager, regional manager (any region), or executive. A record can also set an explicit editor flag.

The confirmed editors are Aby (REACH Manager), Becky (RCM Manager), Kelly Rodriguez (Office Manager), Lacy (Operations Manager), Adela (Regional Manager - North), and Karina (Regional Manager - South). Yasmine is Aging team, so she is not an editor. They keep their existing check-in PINs. The page does not list these names. The Worker matches the role title on the current roster.

Everyone else can view the board and check in. Check-in writes only a staff id, in or out, and a time. It does not unlock editing. After `editorAuthUrl` is set, the shared roster PIN and a Management check-in no longer unlock the board.

## Do these steps in this order

1. Merge the roster pull request, then this one. Open the live dashboard once before you encrypt or purge anything. That first open copies check-in PINs from `backups/2026-10-22_11-33.json` into Firebase. Editors keep those same PINs.

2. Confirm the page still loads. Until `apiKey` and `editorAuthUrl` are both filled in, the office can still edit as they do today. Both are filled in now. Editing unlocks only with an editor PIN. Viewing and check-in keep working even if anonymous sign-in fails, because the database rules are still open.

3. Create a Cloudflare Worker from `workers/editor-auth` and a KV namespace bound as `PINS`. Set secrets `FIREBASE_SERVICE_ACCOUNT` (a Firebase service account JSON that can mint custom tokens) and `EDITOR_ADMIN_SECRET` (a long random string). Deploy the Worker. You already have Cloudflare. You also need that Firebase service account from Project settings → Service accounts. This repo does not deploy the Worker for you.

4. Hash the editors' existing check-in PINs into Cloudflare. From your machine, while `backups/2026-10-22_11-33.json` is still on disk:

    ```bash
    EDITOR_AUTH_URL="https://YOUR-WORKER" EDITOR_ADMIN_SECRET="..." \
      node scripts/seed-editor-pins.mjs --pins backups/2026-10-22_11-33.json
    ```

    Roles come from `board-baseline.json`. PINs come from that backup. The script uploads hashes only and prints names, not PINs. A dry run adds `--dry-run` and uploads nothing. If the backup file is already gone, use Firebase only after step 1 has copied the restored PINs there:

    ```bash
    FIREBASE_DB_SECRET="..." EDITOR_AUTH_URL="https://YOUR-WORKER" EDITOR_ADMIN_SECRET="..." \
      node scripts/seed-editor-pins.mjs --firebase
    ```

    Do not seed from Firebase before that copy. The live database still has the starter roster until then. Five wrong PIN attempts lock that staff id for 15 minutes.

5. Firebase → Authentication → Sign-in method → enable Anonymous, so viewers can read. The web `apiKey`, `projectId`, `appId`, and `editorAuthUrl` are in `firebase-config.js`. Do not put PINs, the admin secret, or the service account in git.

6. Hard-refresh. Click **Unlock editing**, enter an editor's roster name and their existing check-in PIN, and confirm a board change syncs. Another person's PIN fails with the same message as a wrong PIN.

7. Realtime Database → Rules. Paste `firebase/database.rules.json` and publish. Do this only after step 6. An editor must have unlocked once while the rules are still open, and a board change must have synced. Publishing earlier blocks board writes for everyone who is not signed in with an editor token.

8. Set Actions secrets `ALERT_EMAIL`, `BACKUP_ENCRYPTION_KEY`, and `FIREBASE_DB_SECRET` if they are not set. Run **Encrypt historical backups** only after step 1. It encrypts every plaintext backup, checks that each file decrypts to the same bytes, and only then deletes the plaintext and commits `backups-encrypted/*.json.enc`.

    ```bash
    openssl enc -d -aes-256-cbc -pbkdf2 -in backups-encrypted/NAME.json.enc -out NAME.json -pass env:BACKUP_ENCRYPTION_KEY
    ```

    Do not commit the decrypted file. The scheduled job keeps uploading a separate encrypted artifact every 3 hours and does not commit plaintext.

## PIN restore and history

The restore reads `backups/2026-10-22_11-33.json` on the site first, then the same file in commit `ef8a8ad`. Open the dashboard (step 1) and run the seed (step 4) before the encrypt workflow. After that workflow the site copy is gone, but the commit URL works until a history purge. Purge only after Firebase already has the restored board and its check-in PINs, and Cloudflare has the hashes. Deleting plaintext from the latest commit does not remove it from older commits.

## Optional later: change an editor PIN

Not required. The check-in PINs were in the public repo, so you can replace one later if you want. `POST /admin/pin` with the admin secret stores a new hash for that staff id and role. Change the check-in PIN on the board as well if check-in and editing should stay the same PIN. Do not commit the new PIN.

## If the board goes blank

Publish this only long enough to recover, then publish `database.rules.json` again:

```json
{ "rules": { ".read": true, ".write": true } }
```

## What the rules do

- The root is denied.
- `/board` can be read by any signed-in user, including anonymous viewers. Writes require a Firebase token whose `editor` claim is true, plus a complete roster document. Only the Worker can mint that claim, and only after the PIN check.
- `/state` is read-only, so an old cached tab cannot save the starter roster.
- `/zelis` is readable by any signed-in user. Writes require the editor claim.
- `/checkins` accepts new check-in or check-out records from any signed-in user. The record is a staff id, `in` or `out`, and a time. Existing records cannot be edited or deleted through this path.
- `/adminBackups` is denied to every client.
