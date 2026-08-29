// Collects one result POST from the headless page, writes it, and exits.
const http = require('http');
const fs = require('fs');

const OUT = process.argv[2];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    fs.writeFileSync(OUT, Buffer.concat(chunks).toString('utf8'), 'utf8');
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    server.close(() => process.exit(0));
  });
});

server.listen(5200, () => console.log('collector listening on 5200'));
setTimeout(() => {
  fs.writeFileSync(OUT, 'TIMEOUT: no result posted', 'utf8');
  process.exit(1);
}, 120000);
