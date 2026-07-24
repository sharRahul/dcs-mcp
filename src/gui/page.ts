/** The minimalist single-page GUI, served inline (no external assets, no CDN). */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DCS-MCP Mission Builder</title>
<style>
  :root { color-scheme: light dark; --bd:#8884; --accent:#3b82f6; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  h2 { font-size: .95rem; margin: 1.2rem 0 .5rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  fieldset { border: 1px solid var(--bd); border-radius: 8px; margin: 0 0 .75rem; padding: .75rem; }
  legend { padding: 0 .4rem; font-weight: 600; }
  label { display: inline-flex; flex-direction: column; font-size: .8rem; margin: 0 .5rem .4rem 0; gap: 2px; }
  input, select { font: inherit; padding: .3rem .4rem; border: 1px solid var(--bd); border-radius: 6px; background: transparent; color: inherit; min-width: 6rem; }
  button { font: inherit; padding: .35rem .7rem; border: 1px solid var(--bd); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
  button.sec { background: transparent; color: inherit; }
  .row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .25rem; }
  #log { white-space: pre-wrap; background: #0002; border-radius: 8px; padding: .6rem; height: 260px; overflow: auto; font: 12px/1.45 ui-monospace, monospace; }
  .toggle { display: inline-flex; align-items: center; gap: .5rem; }
  .pill { font-size: .75rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid var(--bd); }
  .on { background: #16a34a; color: #fff; border-color: transparent; }
  .off { background: #6b7280; color: #fff; border-color: transparent; }
  .warn { color: #b45309; font-size: .8rem; }
  small { opacity: .7; }
</style>
</head>
<body>
<h1>DCS-MCP Mission Builder</h1>
<small>Local UI over the same tools the MCP server exposes. Offline authoring is always available; live control is gated by the toggle.</small>

<h2>Session</h2>
<fieldset>
  <legend>Open or create</legend>
  <div class="row">
    <label>Theatre<input id="newTheatre" value="Caucasus" /></label>
    <label>Start (s)<input id="newStart" type="number" value="43200" /></label>
    <button onclick="api('/api/miz/new',{theatre:val('newTheatre'),startTime:+val('newStart')},setSession)">New</button>
  </div>
  <div class="row">
    <label style="flex:1">Existing .miz path<input id="openPath" style="width:100%" placeholder="/path/to/mission.miz" /></label>
    <button class="sec" onclick="api('/api/miz/open',{path:val('openPath')},setSession)">Open</button>
  </div>
  <div class="row">
    <span class="pill" id="sessPill">no session</span>
    <button class="sec" onclick="if(sid)api('/api/miz/'+sid+'/summary',null,log,'GET')">Summary</button>
    <button class="sec" onclick="if(sid)api('/api/miz/'+sid+'/diff',null,log,'GET')">Diff</button>
  </div>
</fieldset>

<h2>Authoring (offline)</h2>
<fieldset>
  <legend>Add aircraft group</legend>
  <div class="row">
    <label>Side<select id="acSide"><option>blue</option><option>red</option><option>neutrals</option></select></label>
    <label>Country<input id="acCountry" value="USA" /></label>
    <label>Name<input id="acName" value="Colt 1" /></label>
    <label>Type<input id="acType" value="FA-18C_hornet" /></label>
    <label>Category<select id="acCat"><option>plane</option><option>helicopter</option></select></label>
    <label>Count<input id="acCount" type="number" value="2" /></label>
    <label>x<input id="acX" type="number" value="0" /></label>
    <label>y<input id="acY" type="number" value="0" /></label>
    <label>Alt(m)<input id="acAlt" type="number" value="6096" /></label>
    <button onclick="author('add-aircraft',{side:val('acSide'),country:val('acCountry'),name:val('acName'),type:val('acType'),category:val('acCat'),count:+val('acCount'),x:+val('acX'),y:+val('acY'),altitudeMetres:+val('acAlt')})">Add</button>
  </div>
</fieldset>
<fieldset>
  <legend>Add waypoint / zone / trigger</legend>
  <div class="row">
    <label>Group<input id="wpGroup" value="Colt 1" /></label>
    <label>x<input id="wpX" type="number" value="1000" /></label>
    <label>y<input id="wpY" type="number" value="1000" /></label>
    <label>Alt(m)<input id="wpAlt" type="number" value="6096" /></label>
    <button class="sec" onclick="author('add-waypoint',{group:val('wpGroup'),x:+val('wpX'),y:+val('wpY'),altitudeMetres:+val('wpAlt')})">Add waypoint</button>
  </div>
  <div class="row">
    <label>Zone name<input id="zName" value="CAP Zone" /></label>
    <label>x<input id="zX" type="number" value="0" /></label>
    <label>y<input id="zY" type="number" value="0" /></label>
    <label>Radius<input id="zR" type="number" value="20000" /></label>
    <button class="sec" onclick="author('add-zone',{name:val('zName'),x:+val('zX'),y:+val('zY'),radius:+val('zR')})">Add zone</button>
  </div>
  <div class="row">
    <label>Trigger msg<input id="tMsg" value="Fight's on" /></label>
    <label>After (s)<input id="tSec" type="number" value="60" /></label>
    <button class="sec" onclick="author('add-trigger',{type:'once',conditions:[{kind:'time_after',seconds:+val('tSec')}],actions:[{kind:'message',text:val('tMsg')}]})">Add trigger</button>
  </div>
  <small class="warn">Triggers are written in Mission-Editor form — open the saved .miz in the ME once to finalize them.</small>
</fieldset>
<fieldset>
  <legend>Weather · Briefing · Save</legend>
  <div class="row">
    <label>Temp °C<input id="wTemp" type="number" value="20" /></label>
    <label>QNH mmHg<input id="wQnh" type="number" value="760" /></label>
    <label>Cloud base(m)<input id="wCloud" type="number" value="1200" /></label>
    <button class="sec" onclick="author('set-weather',{temperatureCelsius:+val('wTemp'),qnhMmHg:+val('wQnh'),cloudBaseMetres:+val('wCloud')})">Set weather</button>
  </div>
  <div class="row">
    <label style="flex:1">Briefing title<input id="bTitle" style="width:100%" value="Operation" /></label>
    <button class="sec" onclick="author('set-briefing',{title:val('bTitle'),description:val('bDesc')})">Set briefing</button>
  </div>
  <label style="display:block">Description<input id="bDesc" style="width:100%" value="" /></label>
  <div class="row">
    <label style="flex:1">Save as .miz<input id="savePath" style="width:100%" placeholder="/path/out.miz" /></label>
    <button onclick="if(sid)api('/api/miz/'+sid+'/save',{outPath:val('savePath')},log)">Save</button>
  </div>
</fieldset>

<h2>Live control</h2>
<fieldset>
  <legend>Running DCS <span class="warn">(spawn, message, raw Lua)</span></legend>
  <div class="row toggle">
    <span>Online mode</span>
    <span class="pill off" id="onlinePill">OFF</span>
    <button class="sec" onclick="toggleOnline()">Toggle</button>
    <small class="warn">Enabling unlocks live actions AND raw Lua (needs a de-sanitized DCS + ALLOW_EXEC in the hook).</small>
  </div>
  <div class="row">
    <button class="sec" onclick="live('/api/live/status',{})">Bridge status</button>
    <label>Coalition<select id="lvCoal"><option>all</option><option>blue</option><option>red</option><option>neutral</option></select></label>
    <button class="sec" onclick="live('/api/live/units',{coalition:val('lvCoal')})">List units</button>
  </div>
  <div class="row">
    <label>Msg<input id="lvMsg" value="Hello pilots" /></label>
    <button class="sec" onclick="live('/api/live/message',{text:val('lvMsg'),seconds:20})">Send message</button>
  </div>
  <div class="row">
    <label>Spawn name<input id="spName" value="Convoy" /></label>
    <label>Type<input id="spType" value="M-1 Abrams" /></label>
    <label>Lat<input id="spLat" type="number" value="42.0" /></label>
    <label>Lon<input id="spLon" type="number" value="42.0" /></label>
    <button class="sec" onclick="live('/api/live/spawn',{name:val('spName'),type:val('spType'),lat:+val('spLat'),lon:+val('spLon')})">Spawn ground unit</button>
  </div>
  <div class="row">
    <label style="flex:1">Raw Lua<input id="lvLua" style="width:100%" placeholder="return timer.getTime()" /></label>
    <button class="sec" onclick="live('/api/live/exec',{code:val('lvLua'),env:'mission'})">Execute</button>
  </div>
</fieldset>

<h2>Log</h2>
<div id="log"></div>

<script>
let sid = null;
const val = (id) => document.getElementById(id).value;
const logEl = document.getElementById('log');
function log(x){ logEl.textContent = (typeof x==='string'?x:JSON.stringify(x,null,2)) + "\\n\\n" + logEl.textContent; }
function setSession(r){ if(r.sessionId){ sid = r.sessionId; document.getElementById('sessPill').textContent = sid; } log(r); }
async function api(url, body, cb, method){
  try {
    const res = await fetch(url, { method: method || (body?'POST':'GET'), headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined });
    const j = await res.json(); (cb||log)(j);
  } catch(e){ log('Error: '+e.message); }
}
function author(action, body){ if(!sid) return log('Open or create a session first.'); api('/api/miz/'+sid+'/'+action, body, log); }
function live(url, body){ api(url, body, log); }
async function toggleOnline(){
  const cur = document.getElementById('onlinePill').classList.contains('on');
  await api('/api/online', { enabled: !cur }, (r)=>{ renderOnline(r.online); log(r); });
}
function renderOnline(on){
  const p = document.getElementById('onlinePill');
  p.textContent = on?'ON':'OFF'; p.className = 'pill ' + (on?'on':'off');
}
api('/api/state', null, (r)=>renderOnline(r.online), 'GET');
</script>
</body>
</html>`;
