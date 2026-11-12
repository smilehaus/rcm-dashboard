# Locking the live board

The dashboard is public on GitHub Pages and the Firebase database currently allows anyone to read and write it. These rules close that. Do not paste them until the new page is already signing in, or the board will go blank for the office.

Nothing in this file is applied automatically.

## What the page does today

`firebase-config.js` ships with an empty `apiKey`. While that field is empty, the page does not sign in and keeps working against the open database.

After you paste a web API key and enable Anonymous Auth, the page signs in anonymously before every read and write of `/board`, `/state`, and `/zelis`. Anonymous sign-in stops casual curls. It does not stop someone who loads the page, because the page itself can sign in. `firebase/database.rules.allowlist.json` is the stricter file for later, once staff have verified `@smilehaus.com` accounts. The page does not have a password form yet, so do not paste the allowlist file until a sign-in screen exists. Start with `firebase/database.rules.json`.

## Do these steps in this order

1. Merge and deploy the dashboard that contains `firebase-config.js` and this rules folder. Confirm the live page still loads. It should, because the API key is still empty and the old open rules are still in place.

2. In the Firebase console, open the `smilehaus-rcm` project.

3. Build → Authentication → Sign-in method → Anonymous → Enable → Save.

4. Project settings → General → Your apps. Add a Web app if there is not one yet. Copy the `apiKey` value into `apiKey` in `firebase-config.js`. Leave the other two fields as they are. Commit that file and wait until GitHub Pages is serving it. The API key is meant to be in the page. It is not a password. Do not put a database secret or an app password in that file.

5. Hard-refresh the dashboard. In the browser network panel you should see a call to `identitytoolkit.googleapis.com` and then `board.json` with an `auth` query parameter. Drag a token or open the page and confirm it still loads. Do not continue if that sign-in call fails.

6. Realtime Database → Rules. Open `firebase/database.rules.json` from this repo, paste the whole file, and click Publish. This is the step that locks the database. Old cached copies of the dashboard write to `/state` and will start failing, which is intentional. The new page reads `/board`.

7. GitHub → this repo → Settings → Secrets and variables → Actions → New repository secret.

   - `ALERT_EMAIL` — the mailbox that should receive health-check failures. Use the same mailbox that owns the existing `GMAIL_APP_PASSWORD` app password.
   - `BACKUP_ENCRYPTION_KEY` — a long random passphrase. The backup job will not run until this is set, and it will not commit snapshots to the repo.
   - `FIREBASE_DB_SECRET` — a database secret, created below. The backup job can still read while the rules are open. After you publish the rules, the job needs this secret because database secrets bypass the rules. Do not put this value in the page.

8. Realtime Database → open the overflow menu or Project settings → Service accounts → Database secrets. Add a secret, copy it once into `FIREBASE_DB_SECRET`, and do not commit it. If that screen is gone, use a service account with the Firebase Realtime Database Admin role and exchange it for an access token. A database secret is the shorter path.

9. Actions → RCM Dashboard — Auto Backup → Run workflow. It should upload an artifact named `rcm-backup-…` and must not add a commit. Download it only from a logged-in GitHub account, then decrypt:

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -in rcm-YYYY-MM-DD_HH-MM.json.enc -out snapshot.json -pass env:BACKUP_ENCRYPTION_KEY
   ```

   `BACKUP_ENCRYPTION_KEY` is the secret from step 7. The file in the artifact is ciphertext. Treat the decrypted file like the old private backups and do not commit it.

## If the board goes blank

You published the rules before the live page had an API key, or Anonymous Auth is off. Put the previous open rules back just long enough to restore the office, finish steps 3–5, then publish `database.rules.json` again.

Open rules, only for that emergency:

```json
{ "rules": { ".read": true, ".write": true } }
```

## Later: allowlisted sign-in

`database.rules.allowlist.json` allows only verified `@smilehaus.com` accounts. Anonymous users cannot read or write under that file. Do not publish it until the page has a real sign-in screen and you have signed in once successfully. Until then the anonymous rules are what match the code.

## What the rules do

- The root is denied.
- `/board` requires a signed-in user, must still exist after a write, and must include staff, offices, a numeric `_v`, a `_savedAt` string, and a numeric `_clientBuild`.
- `/state` can be read by a signed-in user and cannot be written. That stops an old cached tab from saving the starter roster.
- `/zelis` requires a signed-in user.
- `/adminBackups` is denied to every client. A database secret still bypasses rules, which is how the backup job reads. Do not store plaintext backups on a path clients can read.
