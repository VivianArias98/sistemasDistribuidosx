const { engine } = require('./src/coordinator/election/engine');
engine.selfId = 'me';
engine.selfUrl = 'http://me:3000';
engine.upsertPeer('vivian', 'http://vivian:3000');

const clusterPeers = engine.knownPeers();
const validWorkers = [];
const selfUrl = engine.selfUrl.replace(/\/$/, "");
const selfId = engine.selfId;

clusterPeers.forEach(peer => {
    const pUrl = (peer.url || "").replace(/\/$/, "");
    if (!pUrl || pUrl === selfUrl || peer.id === selfId) return;
    
    const exists = validWorkers.find(w => (w.url || "").replace(/\/$/, "") === pUrl || w.name === peer.id);
    if (!exists) {
        validWorkers.push({
            name: peer.id || peer.url,
            url: peer.url,
            status: peer.alive ? "ACTIVO" : "CAIDO",
            role: peer.snapshot?.role || (peer.id === engine.leaderId ? "leader" : "follower"),
            platform: "Gossip",
            hostname: "Peer",
            capabilities: [],
            hasPulse: peer.alive,
            secondsWithoutPulse: peer.alive ? 0 : 999
        });
    }
});

console.log(JSON.stringify(validWorkers, null, 2));
