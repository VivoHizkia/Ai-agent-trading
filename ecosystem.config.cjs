// pm2: menjaga bot, notifier, dan dashboard Trading Floor tetap jalan.
//   pm2 start ecosystem.config.cjs   lalu   pm2 save
// Lihat PM2.md untuk cara pakai.
const path = require("path");

const engine = path.join(__dirname, "trading-floor-engine");
const ui = path.join(__dirname, "trading-floor-ui");
const tsx = path.join(engine, "node_modules", "tsx", "dist", "cli.mjs");
const next = path.join(ui, "node_modules", "next", "dist", "bin", "next");

module.exports = {
  apps: [
    {
      name: "tf-bot",
      cwd: engine,
      script: tsx,
      args: "src/exec/bot.ts",
      interpreter: "node",
      autorestart: true,
      // Kill switch (office/execution/STOP) membuat bot keluar normal (kode 0): JANGAN dihidupkan lagi otomatis.
      // Crash (kode selain 0) dihidupkan lagi, dengan jeda yang makin lama kalau crash berulang.
      stop_exit_codes: [0],
      restart_delay: 15000,
      exp_backoff_restart_delay: 15000,
      max_restarts: 50,
      kill_timeout: 10000,
      time: true,
      windowsHide: true,
    },
    {
      name: "tf-notify",
      cwd: engine,
      script: tsx,
      args: "src/agents/notifier.ts",
      interpreter: "node",
      autorestart: true,
      restart_delay: 10000,
      exp_backoff_restart_delay: 10000,
      time: true,
      windowsHide: true,
    },
    {
      name: "tf-dashboard",
      cwd: ui,
      script: next,
      args: "start -p 3000",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      time: true,
      windowsHide: true,
    },
  ],
};
