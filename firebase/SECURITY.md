# Locking the live board

The dashboard is public on GitHub Pages. Do not paste these rules until the new page is deployed and an editor has signed in once. Nothing here is applied automatically.

Editors are not stored in this repo. You add them in the Firebase console after each person signs in. Do not put their email addresses in git.

## Who can edit

For now there is one editor. They sign in with Google using the personal Gmail account you choose. The account does not have to be a company address. The page accepts any verified Google account. Editing is allowed only when that person's Firebase user id is listed under `/editors/{uid}` with `editor` set to true.

To add another editor later, they sign in once, you copy the user id the page shows, and you add another child under `editors` the same way. No code change and no email address in the repo.

The people who should be editors, now or later, are the RCM manager, office managers, executives, and the ops manager. Everyone else can view the board and check in with their PIN. Check-in does not make someone an editor. Once the web API key is in the page, the old shared roster PIN and a Management check-in no longer unlock editing.

## Do these steps in this order

1. Merge the roster pull request, then this one. Open the live dashboard once before you encrypt or purge anything. That first open copies check-in PINs from `backups/2026-10-22_11-33.json` into Firebase. The plaintext file is still on the site at this point.

2. Confirm the page still loads. The API key is empty, so the database is still open and the office can keep working.

3. Authentication → Sign-in method. Enable Anonymous. Enable Google. In Google's settings, the authorized domain must include `smilehaus.github.io`.

4. Project settings → Your apps → Web app. Copy the `apiKey` into `firebase-config.js`, commit, and wait for GitHub Pages. Do not put a database secret or anyone's email in that file.

5. The one editor opens the dashboard and clicks **Sign in to edit** with their Google account. Any verified Google account works. The page shows their user id and says they are not an editor yet. Do not write that email address into the repo.

6. Realtime Database → Data. Under `editors`, add one child. The child key is the user id from step 5, not an email address. Set `editor` to true and `role` to a short label such as `Owner`. Clients cannot write this path. The console can, because it uses admin access. Adding another editor later is the same step with a new user id. Do not copy those records into the git repo.

7. That editor refreshes and confirms the lock badge shows their role and that a board change syncs.

8. Realtime Database → Rules. Paste `firebase/database.rules.json` and publish. Do this only after step 7. Publishing earlier makes the board read-only until an editor signs in, and a non-editor cannot publish the restored roster.

9. Create these Actions secrets if they are not set yet: `ALERT_EMAIL` (the health-check mailbox, the same one that owns `GMAIL_APP_PASSWORD`), `BACKUP_ENCRYPTION_KEY` (a long random passphrase), and `FIREBASE_DB_SECRET` (a database secret from Project settings → Service accounts → Database secrets). The database secret bypasses rules so the backup job can still read. Do not put it in the page.

10. Actions → **Encrypt historical backups** → Run workflow. It encrypts every `backups/*.json`, checks that each file decrypts to the same bytes, and only then deletes the plaintext and commits `backups-encrypted/*.json.enc`. If a check fails, the plaintext stays and nothing is committed. Decrypt one file with:

    ```bash
    openssl enc -d -aes-256-cbc -pbkdf2 -in backups-encrypted/NAME.json.enc -out NAME.json -pass env:BACKUP_ENCRYPTION_KEY
    ```

    Do not commit the decrypted file.

11. The scheduled backup job keeps uploading a new encrypted artifact every 3 hours. It does not commit plaintext.

## PIN restore and the plaintext files

The restore looks for `backups/2026-10-22_11-33.json` on the site first, then the same file in commit `ef8a8ad` on GitHub. Step 1 (open the dashboard) should happen before step 10. After step 10 the site copy is gone, but the commit URL still works until someone rewrites git history. A history purge deletes that copy too. Purge only after the restored board, including PINs, is already in Firebase. Deleting plaintext from the latest commit does not remove it from older commits.

## If the board goes blank

Publish this only long enough to recover, then publish `database.rules.json` again:

```json
{ "rules": { ".read": true, ".write": true } }
```

## What the rules do

- The root is denied.
- `/board` can be read by any signed-in user, including anonymous viewers. Writes require a verified Google account whose user id is on the editor list, plus a complete roster document.
- `/state` is read-only, so an old cached tab cannot save the starter roster.
- `/zelis` is readable by any signed-in user. Writes require an editor.
- `/editors/{uid}` can be read only by that user. No client can write it.
- `/checkins` accepts new check-in or check-out records from any signed-in user. The record can only contain a staff id, `in` or `out`, and a time. Existing records cannot be edited or deleted through this path.
- `/adminBackups` is denied to every client.
