-- Generated examples under mocked DCS APIs; this is not a simulator flight.
assert(_VERSION == 'Lua 5.1')
dofile(arg[1]); dofile(arg[2]); dofile(arg[3])
local now, flags, changed, groupsDead, unitsDead, zones, active, scheduled = 0, {}, {}, {}, {}, {}, {}, {}
local function set(flag, value)
  flag = tonumber(flag)
  if (flags[flag] or 0) ~= value then changed[flag] = now end
  flags[flag] = value
end
trigger = {misc={getUserFlag=function(f) return flags[tonumber(f)] or 0 end},action={setUserFlag=set}}
timer = {getTime=function() return now end,scheduleFunction=function(fn,args,at) scheduled[#scheduled+1]={fn=fn,args=args,at=at} end}
world = {event={S_EVENT_TAKEOFF=3,S_EVENT_LAND=4},addEventHandler=function() end}
env = {error=function(s) error(s) end}
function getValueDictByKey(k) return dictionary[k] or k end
function c_time_after(t) return now >= t end
function c_time_since_flag(f,t) return changed[f] ~= nil and now-changed[f] >= t end
function c_flag_is_true(f) return (flags[f] or 0) ~= 0 end
function c_flag_is_false(f) return (flags[f] or 0) == 0 end
function c_flag_equals(f,v) return (flags[f] or 0) == v end
function c_group_dead(g) return groupsDead[g] == true end
function c_unit_dead(u) return unitsDead[u] == true end
function c_unit_in_zone(u,z) return zones[z] == true end
function c_part_of_group_in_zone(g,z) return zones[z] == true end
function c_all_of_group_in_zone(g,z) return zones[z] == true end
function a_set_flag(f) set(f,1) end
function a_set_flag_value(f,v) set(f,v) end
function a_activate_group(g) active[g] = true end
function a_out_text_delay_s() end
function a_mark_to_all() end
function a_do_script(text) assert(loadstring(text))() end
for _,section in ipairs({'conditions','actions','func','funcStartup'}) do
  for i,text in pairs(mission.trig[section] or {}) do mission.trig[section][i]=assert(loadstring(text)) end
end
for _,fn in pairs(mission.trig.funcStartup) do fn() end
local function tick(t)
  now=t
  local keys={}; for i in pairs(mission.trig.func) do keys[#keys+1]=i end
  table.sort(keys,function(a,b) if manifest.order=='reverse' then return a>b else return a<b end end)
  for _,i in ipairs(keys) do if mission.trig.func[i] then mission.trig.func[i]() end end
  local ready=scheduled; scheduled={}
  for _,s in ipairs(ready) do if s.at<=now then s.fn(s.args,s.at) else scheduled[#scheduled+1]=s end end
end
local function unresolved() assert((flags[manifest.outcome] or 0)==0,'Premature victory') end
local function deadGroup(name) groupsDead[manifest.groups[name]]=true end
local function deadUnit(name) unitsDead[manifest.units[name]]=true end
local function inZone(name) zones[manifest.zones[name]]=true end
local failed=manifest.mode=='failure'
tick(0)
if manifest.kind=='cas' then
  local cas=assert(manifest.cas,'CAS expectations missing')
  inZone('Egress Gate'); tick(10); unresolved()
  if cas.trigger=='primary' then deadGroup('Primary Targets')
  elseif cas.trigger=='secondary' then deadGroup('Secondary Targets')
  else inZone('Battle Area') end
  tick(20); tick(20+cas.delay-1)
  assert(not active[manifest.groups.Reserve],'CAS reserve released before its delay')
  tick(20+cas.delay); tick(21+cas.delay)
  assert(active[manifest.groups.Reserve],'CAS reserve never activated')
  unresolved()
  zones[manifest.zones['Egress Gate']]=false
  deadGroup('Primary Targets'); deadGroup('Secondary Targets'); deadGroup('Reserve')
  tick(22+cas.delay); tick(23+cas.delay); unresolved()
  inZone('Egress Gate')
  if cas.convoyArrival then tick(24+cas.delay); unresolved(); inZone('Protected Destination') end
  if failed then deadUnit(cas.protected) end
  tick(25+cas.delay); tick(26+cas.delay); tick(27+cas.delay)
elseif manifest.kind=='strike' then
  inZone('Egress Gate'); tick(10); unresolved()
  inZone('Base Perimeter'); tick(20); tick(79)
  assert(not active[manifest.groups['Base Scramble']],'Base fighters scrambled before the delay')
  tick(80); tick(81)
  assert(active[manifest.groups['Base Scramble']],'Base fighters did not scramble')
  deadGroup('Base Command'); deadGroup('Base Logistics'); tick(82); tick(83); unresolved()
  zones[manifest.zones['Egress Gate']]=false
  deadGroup('Base Armour'); tick(84); tick(85); unresolved()
  inZone('Egress Gate'); if failed then deadUnit('Ranger-1') end
  tick(86); tick(87); tick(88)
elseif manifest.kind=='sead' then
  deadUnit('Corridor SAM-1'); tick(10); tick(29)
  assert(not active[manifest.groups.Hammer],'Strike activated before the radar-down delay')
  tick(30); tick(31)
  assert(active[manifest.groups.Hammer],'Strike did not release after radar destruction')
  deadGroup('Logistics'); if failed then deadUnit('Viper-1') end
  tick(32); tick(33); tick(34)
elseif manifest.kind=='convoy_escort' then
  inZone('Destination'); tick(10); unresolved()
  inZone('Checkpoint'); tick(20); tick(109); unresolved()
  assert(not active[manifest.groups.Reinforcements],'Second ambush activated too soon')
  tick(110); tick(111)
  assert(active[manifest.groups.Ambush] and active[manifest.groups.Reinforcements],'Ambush waves missing')
  unresolved(); deadGroup('Ambush'); deadGroup('Reinforcements')
  if failed then deadUnit('Convoy-2') end
  tick(112); tick(113); tick(114)
elseif manifest.kind=='carrier_operations' then
  deadGroup('Raid One'); tick(10); tick(299); unresolved()
  assert(not active[manifest.groups['Raid Two']],'Raid Two activated too soon')
  tick(300); tick(301)
  assert(active[manifest.groups['Raid Two']],'Raid Two missing')
  unresolved(); deadGroup('Raid Two'); if failed then deadUnit('Carrier-1') end
  tick(302); tick(303); tick(304)
else
  deadGroup('Bombers'); if failed then deadGroup('Defenders') end
  tick(10); tick(11); tick(12)
end
assert(flags[manifest.outcome]==(failed and 2 or 1),'Incorrect final outcome')
print('SCENARIO_EXAMPLE_OK '..manifest.kind..' '..manifest.mode..' '..manifest.order..'; mocked APIs, not DCS flight')
