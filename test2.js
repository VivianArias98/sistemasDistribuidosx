const axios = require('axios');
async function test() {
    let allWorkers = [];
    const MIDDLEWARE_URL = 'https://gratified-landslide-playful.ngrok-free.dev';
    try {
        const srvRes = await axios.get(`${MIDDLEWARE_URL}/servers`, { timeout: 3000 });
        if (srvRes.data && Array.isArray(srvRes.data.servers)) {
            allWorkers = allWorkers.concat(srvRes.data.servers.map(s => ({
                name: s.name,
                url: s.url,
                status: s.status === "active" ? "ACTIVO" : "CAIDO",
                role: "worker"
            })));
        }
        const peersRes = await axios.get(`${MIDDLEWARE_URL}/election/state`, { timeout: 3000 });
        if (peersRes.data && Array.isArray(peersRes.data.peers)) {
            allWorkers = allWorkers.concat(peersRes.data.peers.map(p => ({
                name: p.id || p.url,
                url: p.url,
                status: p.alive ? "ACTIVO" : "CAIDO",
                role: "follower"
            })));
            if (!allWorkers.find(w => w.name === peersRes.data.id)) {
                allWorkers.unshift({
                    name: peersRes.data.id,
                    url: peersRes.data.url,
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
