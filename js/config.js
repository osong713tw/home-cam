// 配對伺服器設定（一般不用改）
// 預設使用 PeerJS 官方提供的免費公用配對伺服器（0.peerjs.com）。
// 配對伺服器只負責「介紹」裝置互相認識，影像與聲音是裝置之間直接傳送，不會經過它。
// 若日後想改用自己架設的 PeerJS Server，可以改成例如：
//   window.IPCAM_PEER_OPTIONS = { host: 'your-server.example.com', port: 443, path: '/', secure: true };
// 若要指定自己的 STUN／TURN 中繼伺服器（例如需要穩定的 4G/5G 遠端監看），加上 config：
//   window.IPCAM_PEER_OPTIONS = { config: { iceServers: [
//     { urls: 'stun:stun.l.google.com:19302' },
//     { urls: 'turn:你的TURN主機:3478', username: '帳號', credential: '密碼' },
//   ] } };
// 注意：一旦自行指定 config，PeerJS 內建的免費公用 TURN 就不會再使用。
window.IPCAM_PEER_OPTIONS = {};
