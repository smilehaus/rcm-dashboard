// Public Firebase web config. The apiKey identifies the project; it is not a
// password. editorAuthUrl is the Cloudflare Worker that checks an editor PIN.
// Database rules are still open until they are pasted in the Firebase console.
// Steps: firebase/SECURITY.md
window.FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyBVc3NDXUuuTYXUQKxMuXAlZ4958LGJ6u4",
  authDomain: "smilehaus-rcm.firebaseapp.com",
  projectId: "smilehaus-rcm",
  databaseURL: "https://smilehaus-rcm-default-rtdb.firebaseio.com",
  appId: "1:866154756045:web:5bf404d1c815a020917684",
  editorAuthUrl: "https://rcm-editor-auth.smilehaus.workers.dev"
};
