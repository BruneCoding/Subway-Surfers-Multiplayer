// Multiplayer configuration.
//
// backend:
//   'auto'     -> Firebase if databaseURL is filled in below, otherwise 'local'
//   'local'    -> same-browser only (several tabs on this computer). Zero setup, good for testing.
//   'firebase' -> Firebase Realtime Database (different computers / phones / anywhere)
//
// Force a backend per page load with  ?net=local  or  ?net=firebase
//
// Realtime Database rules (Firebase console -> Realtime Database -> Rules). Test mode is fine:
//   { "rules": { ".read": true, ".write": true } }
// Paths used: mp-rooms (incl. mp-rooms/<code>/chat), mp-lobbies, mp-chat/global, mp-accounts, mp-profiles.
// A ready-made copy of these rules is in database.rules.json (paste it into the console, or `firebase deploy --only database`).
//
// logo: put Logo.png next to index.html to use it offline; otherwise the GitHub copy is loaded.
window.MP_CONFIG = {
  backend: 'auto',
  logo: 'assets/preload/splash.webp',
  logoFallback: 'https://raw.githubusercontent.com/BruneCoding/ArborUltra/main/Logo.png',
  firebase: {
    apiKey: "AIzaSyD8y688pS9DuPGqjWHZRpp21Fp98vfOEaY",
    authDomain: "testing-3c4e4.firebaseapp.com",
    databaseURL: "https://testing-3c4e4-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "testing-3c4e4",
    storageBucket: "testing-3c4e4.firebasestorage.app",
    messagingSenderId: "35583575367",
    appId: "1:35583575367:web:db7ed11b5417955065f862",
    measurementId: "G-0KWS0ZVY0C"
  }
};
(function () {
  var n = new URLSearchParams(location.search).get('net');
  if (n === 'local' || n === 'firebase') window.MP_CONFIG.backend = n;
})();
