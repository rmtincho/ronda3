const os = require('os');

const VIRTUAL_ADAPTER = /(vethernet|virtualbox|vmware|vbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|utun|bridge)/i;

// IP de la compu en la Wi-Fi, para armar el link y el QR que escanean los celulares.
function getLanAddress() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const addr of addresses || []) {
      if ((addr.family !== 'IPv4' && addr.family !== 4) || addr.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(addr.address)) score = 3;
      else if (/^10\./.test(addr.address)) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) score = 1;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 1;
      if (VIRTUAL_ADAPTER.test(name)) score -= 5;
      candidates.push({ address: addr.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || 'localhost';
}

function isLocalHost(host) {
  return /^(localhost|127\.|\[::1\])/i.test(String(host || ''));
}

module.exports = { getLanAddress, isLocalHost };
