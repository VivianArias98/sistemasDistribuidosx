const axios = require('axios');
async function test() {
    let allWorkers = [];
    const MIDDLEWARE_URL = 'https://gratified-landslide-playful.ngrok-free.dev';
    let leaderName = "Admin";
    try {
        const stateRes = await axios.get(`${MIDDLEWARE_URL}/election/state`, { timeout: 2000 });
        if (stateRes.data && stateRes.data.leader) leaderName = stateRes.data.leader;
    } catch (e) {}
    try {
        const srvRes = await axios.get(`${MIDDLEWARE_URL}/servers`, { timeout: 3000 });
        const serversArr = Array.isArray(srvRes.data) ? srvRes.data : (srvRes.data.servers || []);
        allWorkers = allWorkers.concat(serversArr.map(s => ({
            name: s.name,
            url: s.url,
            status: s.status === "active" ? "ACTIVO" : "CAIDO",
            role: "worker"
        })));
        const peersRes = await axios.get(`${MIDDLEWARE_URL}/election/state`, { timeout: 3000 });
        if (peersRes.data) {
            const peersArr = Array.isArray(peersRes.data.peerDetails) ? peersRes.data.peerDetails : (Array.isArray(peersRes.data.peers) ? peersRes.data.peers : []);
            allWorkers = allWorkers.concat(peersArr.map(p => {
                if (typeof p === "string") {
                    return { name: p, url: p, status: "ACTIVO", role: "follower" };
                }
                return {
                    name: p.id || p.url,
                    url: p.url,
                    status: p.alive ? "ACTIVO" : "CAIDO",
                    role: p.id === leaderName ? "leader" : "follower"
                };
            }));
            if (!allWorkers.find(w => w.name === peersRes.data.id)) {
                allWorkers.unshift({
                    name: peersRes.data.id,
                    url: peersRes.data.url || MIDDLEWARE_URL,
                    status: "ACTIVO",
                    role: peersRes.data.role
                });
            }
        }
    } catch (err2) {
        console.error(err2.message);
    }
    console.log(JSON.stringify(allWorkers, null, 2));
}
test();
