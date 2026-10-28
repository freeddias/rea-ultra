// "YYYY-MM-DD hh:mm:ss" as parsed by the client's Nl.parse
function sysTime(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
module.exports = { sysTime };
