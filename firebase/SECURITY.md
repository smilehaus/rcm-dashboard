# Locking the live board

The dashboard is public on GitHub Pages. Do not paste the rules until an editor has unlocked the board once. Nothing here is applied automatically.

Editor PINs and the role records live in Cloudflare KV, not in this repo.

## Who can edit

Editing is unlocked with a staff PIN. A Cloudflare Worker checks that PIN against a hash it stores with the person's role. The page never decides this by itself.

A stored role can edit when it is RCM manager, REACH manager, office manager, operations manager, regional manager (any region), or executive. A record can also set an explicit editor flag.

The confirmed editors are Aby (REACH Manager), Becky (RCM Manager), Kelly Rodriguez (Office Manager), Lacy (Operations Manager), Yasmine (Office Manager), Adela (Regional Manager - North), and Karina (Regional Manager - South). Set a new PIN for each of them with the admin call below. The page does not list these names. The Worker matches the role title.

Everyone else can view the board and check in. Check-in writes only a staff id, in or out, and a time. It does not unlock editing. After `editorAuthUrl` is set, the shared roster PIN and a Management check-in no longer unlock the board.

## Do these steps in this order

1. Merge the roster pull request, then this one. Open the live dashboard once before you encrypt or purge anything. That first open copies check-in PINs from `backups/2026-10-22_11-33.json` into Firebase. Those PINs were in the public repo. The editor PIN you create in step 4 should be a new one.

2. Confirm the page still loads. `apiKey` and `editorAuthUrl` are empty, so the office can still edit as they do today.

3. Create a Cloudflare Worker from `workers/editor-auth` and a KV namespace bound as `PINS`. Set secrets `FIREBASE_SERVICE_ACCOUNT` (a Firebase service account JSON that can mint custom tokens) and `EDITOR_ADMIN_SECRET` (a long random string). Deploy the Worker. You already have Cloudflare. You also need that Firebase service account from Project settings → Service accounts. This repo does not deploy the Worker for you.

4. Set a new PIN for each confirmed editor from your machine. Do not commit the command with a real PIN filled in:

    ```bash
    curl -X POST "$EDITOR_AUTH_URL/admin/pin" \
      -H "Authorization: Bearer $EDITOR_ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"staffId":"STAFF_ID","pin":"NEW_PIN","role":"REACH Manager"}'
    ```

    Use the staff id from the roster. Repeat the call for each later editor, with their role title. Five wrong PINs lock that staff id for 15 minutes.

5. Firebase → Authentication → Sign-in method → enable Anonymous, so viewers can read. Project settings → Your apps → copy the web `apiKey` into `firebase-config.js`, and set `editorAuthUrl` to the Worker URL. Commit that file. Do not put PINs, the admin secret, or the service account in git.

6. Hard-refresh. Click **Unlock editing**, enter the editor's roster name and new PIN, and confirm a board change syncs. Another person's PIN fails with the same message as a wrong PIN.

7. Realtime Database → Rules. Paste `firebase/database.rules.json` and publish. Do this only after step 6.

8. Set Actions secrets `ALERT_EMAIL`, `BACKUP_ENCRYPTION_KEY`, and `FIREBASE_DB_SECRET` if they are not set. Run **Encrypt historical backups** only after step 1. It encrypts every plaintext backup, checks that each file decrypts to the same bytes, and only then deletes the plaintext and commits `backups-encrypted/*.json.enc`.

    ```bash
    openssl enc -d -aes-256-cbc -pbkdf2 -in backups-encrypted/NAME.json.enc -out NAME.json -pass env:BACKUP_ENCRYPTION_KEY
    ```

    Do not commit the decrypted file. The scheduled job keeps uploading a separate encrypted artifact every 3 hours and does not commit plaintext.

## PIN restore and history

The restore reads `backups/2026-10-22_11-33.json` on the site first, then the same file in commit `ef8a8ad`. Open the dashboard (step 1) before the encrypt workflow. After that workflow the site copy is gone, but the commit URL works until a history purge. Purge only after Firebase already has the restored board and its check-in PINs. Editor PINs in Cloudflare are separate and should be the new ones. Deleting plaintext from the latest commit does not remove it from older commits.

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
