/**
 * debug.routes.js — Endpoints de inyección de caos
 *
 * POST /debug/faults/pause
 * POST /debug/faults/resume
 * POST /debug/faults/partition   { target: "url" }
 * POST /debug/faults/heal        { target?: "url" }  (sin target = sanar todo)
 * POST /debug/faults/latency     { ms: 500 }
 * POST /debug/faults/drop-rate   { rate: 0.3 }
 * GET  /debug/faults             — Estado actual
 */
const express = require("express");
const faults  = require("../election/faults");

const router = express.Router();

router.post("/debug/faults/pause",   (_req, res) => { faults.pause();   res.json({ ok: true, paused: true  }); });
router.post("/debug/faults/resume",  (_req, res) => { faults.resume();  res.json({ ok: true, paused: false }); });

router.post("/debug/faults/partition", (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: "Se requiere 'target' (URL)" });
    faults.partition(target);
    res.json({ ok: true, partitioned: target });
});

router.post("/debug/faults/heal", (req, res) => {
    const { target } = req.body;
    if (target) {
        faults.heal(target);
        res.json({ ok: true, healed: target });
    } else {
        faults.healAll();
        res.json({ ok: true, healed: "all" });
    }
});

router.post("/debug/faults/latency", (req, res) => {
    const ms = parseInt(req.body.ms, 10);
    if (isNaN(ms) || ms < 0) return res.status(400).json({ error: "'ms' debe ser un número >= 0" });
    faults.setLatency(ms);
    res.json({ ok: true, latencyMs: ms });
});

router.post("/debug/faults/drop-rate", (req, res) => {
    const rate = parseFloat(req.body.rate);
    if (isNaN(rate) || rate < 0 || rate > 1) return res.status(400).json({ error: "'rate' debe ser un número entre 0.0 y 1.0" });
    faults.setDropRate(rate);
    res.json({ ok: true, dropRate: rate });
});

router.get("/debug/faults", (_req, res) => {
    res.json(faults.snapshot());
});

module.exports = router;
