--[[
  dcs-mcp-server LIVE CONTROL hook.

  Install into:  Saved Games/DCS/Scripts/Hooks/dcs-mcp-hook.lua

  This is a GUI-hook script, so it can reach the DCS *mission scripting*
  environment through net.dostring_in('mission', ...). That gives the MCP server
  full live control: query units, spawn groups, send messages, convert
  coordinates, and (optionally) run raw Lua.

  It opens a local, non-blocking TCP server. Each connection carries one JSON
  request line and receives one JSON response line:

    -> {"cmd":"units","args":{"coalition":"blue"}}
    <- {"ok":true,"data":[ ... ]}

  SECURITY
    * Binds to 127.0.0.1 only.
    * Structured commands build vetted Lua internally; the model never supplies Lua.
    * The raw "exec" command is DISABLED unless you set ALLOW_EXEC = true below.
      Enabling exec runs arbitrary Lua inside DCS and requires a de-sanitized
      MissionScripting.lua -- only do this on a machine you control.

  Reference: DCS Lua Export -- https://www.digitalcombatsimulator.com/en/dev_journal/lua-export/
--]]

local HOST = "127.0.0.1"
local PORT = 8899
local ALLOW_EXEC = false        -- set true to enable the raw dcs_execute_lua tool
local MAX_REQUEST_BYTES = 4 * 1024 * 1024
local MAX_PENDING = 32
local MAX_UNITS = 2000          -- cap on units returned by the "units" command
local MAX_ACCEPTS_PER_FRAME = 4 -- connections accepted per simulation frame
local REQUEST_TIMEOUT_S = 5     -- drop a client that never finishes its request line

-- luasocket ships with DCS, but a broken install must not take the whole hook
-- down: without this guard a failed require aborts the script and DCS silently
-- loads no callbacks at all.
local okSocket, socket = pcall(require, "socket")
if not okSocket or not socket then
  log.write("DCS-MCP", log.ERROR, "could not load luasocket; the MCP bridge is disabled: " .. tostring(socket))
  return
end

local MAX_ERRORS = 50           -- most recent hook-side errors kept for the client

local server = nil
local pending = {}              -- in-flight clients: { sock, buffer, deadline }

-- What DCS is doing right now, so a client can tell "no mission running" apart
-- from "the bridge is down".
local missionState = { phase = "menu", name = nil, loadError = nil }

-- When the simulation last ticked. Mission-environment work only happens on the
-- simulation thread, so this is both the gate for holding such requests and the
-- honest answer to "is the mission environment reachable right now?" — a paused
-- mission has a phase of "running" and no frames at all.
local lastSimFrame = 0
local SIM_STALL_S = 2

-- Ring buffer of problems the hook itself saw. dcs.log is the fuller record;
-- this is what the bridge can hand back directly.
local errors = {}

local function recordError(what, detail)
  errors[#errors + 1] = { time = os.date("%Y-%m-%d %H:%M:%S"), what = what, detail = tostring(detail) }
  while #errors > MAX_ERRORS do table.remove(errors, 1) end
  log.write("DCS-MCP", log.ERROR, tostring(what) .. ": " .. tostring(detail))
end

----------------------------------------------------------------------
-- JSON encoder (used hook-side and embedded into mission-env snippets)
----------------------------------------------------------------------
local JSON_ENC_SRC = [[
local function enc(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.9g", v)
  end
  if t == "boolean" then return v and "true" or "false" end
  if t == "string" then
    local s = v:gsub('[%z\1-\31\\"]', function(c)
      local m = {['"']='\\"',['\\']='\\\\',['\n']='\\n',['\r']='\\r',['\t']='\\t'}
      return m[c] or string.format("\\u%04x", string.byte(c))
    end)
    return '"' .. s .. '"'
  end
  if t == "table" then
    local n, isArray = 0, true
    for k in pairs(v) do n = n + 1; if type(k) ~= "number" then isArray = false end end
    local parts = {}
    if isArray and n > 0 then
      for i = 1, n do parts[#parts+1] = enc(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    if n == 0 then return "{}" end
    for k, val in pairs(v) do parts[#parts+1] = enc(tostring(k)) .. ':' .. enc(val) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end
]]

-- DCS runs Lua 5.1, where `load` takes a READER FUNCTION and only `loadstring`
-- compiles a string. Calling load(string) here aborts the whole hook, and DCS
-- reports it only as one line in dcs.log while the bridge silently never starts.
local compile = loadstring or load
local enc = assert(compile(JSON_ENC_SRC .. "\nreturn enc"))()

local function ok(data) return '{"ok":true,"data":' .. enc(data) .. '}' end
local function fail(msg) return '{"ok":false,"error":' .. enc(tostring(msg)) .. '}' end

----------------------------------------------------------------------
-- Run a snippet in a DCS state; the snippet must RETURN a full envelope
-- string (built with the embedded encoder). Errors are wrapped safely.
----------------------------------------------------------------------
--[[
  Which net.dostring_in state is the mission SCRIPTING environment (timer,
  coalition, env, trigger)? It moved between DCS versions, so it is detected,
  not assumed:
    - DCS 2.9.25 (verified July 2026): "mission".
    - DCS 2.9.31 (verified 2026-11-16 by the state probe): "server". There,
      "mission" is the trigger state (a_do_script exists, timer is nil), which is
      exactly why every mission-env command failed with "index global 'timer'".
  Resolved on first use with a fixed read-only snippet, cached until the next
  mission starts (resetScriptingState), and only ever on the simulation thread.
--]]
local SCRIPTING_CANDIDATES = { "server", "mission" }
local scriptingState = nil

local function resolveScriptingState()
  if scriptingState then return scriptingState end
  for _, state in ipairs(SCRIPTING_CANDIDATES) do
    local okp, res = pcall(net.dostring_in, state, "return type(timer) .. ',' .. type(coalition)")
    if okp and res == "table,table" then
      scriptingState = state
      log.write("DCS-MCP", log.INFO, "mission scripting environment is net.dostring_in state '" .. state .. "'")
      return state
    end
  end
  return "mission" -- nothing answered; keep the historical default and let the caller report it
end

local function resetScriptingState() scriptingState = nil end

local function runIn(state, body)
  -- "mission" here means "the mission scripting environment", wherever DCS keeps it.
  if state == "mission" then state = resolveScriptingState() end
  local snippet = JSON_ENC_SRC .. "\n" ..
    "local ok_, res_ = pcall(function()\n" .. body .. "\nend)\n" ..
    "if ok_ then return res_ else return '{\"ok\":false,\"error\":' .. enc(tostring(res_)) .. '}' end"
  local out = net.dostring_in(state, snippet)
  if type(out) ~= "string" or out == "" then
    return fail("net.dostring_in('" .. state .. "') returned no data (is a mission running?)")
  end
  return out
end

-- Hook-owned observer: scripts loaded by a_do_script may have private globals.
-- Installed on a sim frame, never the GUI tick. No raw input is executed.
local observerReady, observerAttempts, observerEpoch = false, 0, 0
local function installEventObserver()
  local result = runIn("mission", string.format([[
    local epoch = %d
    if not world or not world.addEventHandler then return '{"available":false}' end
    if DCSMCP_BRIDGE_EVENTS and DCSMCP_BRIDGE_EVENTS.epoch ~= epoch then
      if world.removeEventHandler then pcall(world.removeEventHandler, DCSMCP_BRIDGE_EVENTS) end
      DCSMCP_BRIDGE_EVENTS = nil
    end
    if not DCSMCP_BRIDGE_EVENTS then
      local ring = { events = {}, eventSequence = 0, source = "hook_observer", epoch = epoch }
      DCSMCP_BRIDGE_EVENTS = ring
      local names = {}
      for name, id in pairs(world.event or {}) do names[id] = name end
      local interesting = { S_EVENT_SHOT=true, S_EVENT_HIT=true, S_EVENT_KILL=true,
        S_EVENT_DEAD=true, S_EVENT_CRASH=true, S_EVENT_EJECTION=true,
        S_EVENT_TAKEOFF=true, S_EVENT_LAND=true, S_EVENT_PILOT_DEAD=true,
        S_EVENT_BIRTH=true, S_EVENT_ENGINE_STARTUP=true, S_EVENT_MISSION_END=true,
        S_EVENT_PLAYER_ENTER_UNIT=true, S_EVENT_SHOOTING_START=true, S_EVENT_BASE_CAPTURED=true }
      local function describe(obj)
        if obj == nil then return "none" end
        local ok, name = pcall(function() return obj:getName() end)
        return ok and name or "unknown"
      end
      function ring:onEvent(event)
        pcall(function()
          local kind = names[event.id]
          if not interesting[kind] then return end
          self.eventSequence = self.eventSequence + 1
          self.events[#self.events+1] = {sequence=self.eventSequence,time=event.time or timer.getTime(),kind=kind,
            initiator=describe(event.initiator),target=describe(event.target),weapon=describe(event.weapon),place=describe(event.place)}
          while #self.events>256 do table.remove(self.events,1) end
        end)
      end
      world.addEventHandler(ring)
    end
    return '{"available":true}'
  ]], observerEpoch))
  return type(result)=='string' and result:find('"available":true',1,true) ~= nil
end

----------------------------------------------------------------------
-- Command handlers. Structured ones return an envelope STRING.
----------------------------------------------------------------------
-- Self-contained mission-side aircraft diagnostics. State belongs to the loaded
-- mission, never the GUI hook, and disappears when DCS replaces the mission state.
local AIRCRAFT_SRC = [==[
local A = DCSMCP_AIRCRAFT or { histories={}, monitors={}, writes={}, suspensions={}, serial=0, events={} }
DCSMCP_AIRCRAFT = A
local function finite(v) return type(v)=='number' and v==v and v~=math.huge and v~=-math.huge end
local function name(v) assert(type(v)=='string' and #v>0 and #v<=200,'invalid name'); return v end
local function count(t) local n=0;for _ in pairs(t) do n=n+1 end;return n end
local function bounded(t,k,limit) assert(t[k] or count(t)<limit,'aircraft state limit reached; remove unused monitors or reset history'); end
local function safe(o,m,...) if not o or type(o[m])~='function' then return nil end;local ok,v=pcall(o[m],o,...);if ok then return v end end
local function zone(z)
 if z==nil then return end
 assert(type(z)=='table' and finite(z.x) and finite(z.y) and finite(z.radiusMetres) and z.radiusMetres>0 and z.radiusMetres<=500000,'invalid zone')
end
local function vec(v) if type(v)=='table' and finite(v.x) and finite(v.y) and finite(v.z) then return {x=v.x,y=v.y,z=v.z} end end
local function inside(p,z) return p and z and (p.x-z.x)^2+(p.z-z.y)^2<=z.radiusMetres^2 or false end
local function flag(k) return k and trigger.misc.getUserFlag(k)==1 or false end
local function validateFlag(k) if k~=nil then name(k);assert(#k<=64,'flag name too long') end end
local function authored(n)
 for _,side in pairs(env.mission.coalition or {}) do
  for _,country in pairs(side.country or {}) do
   for _,cat in ipairs({'plane','helicopter'}) do
    for _,g in pairs(country[cat] and country[cat].group or {}) do if g.name==n then return g end end
   end
  end
 end
end
local function group(n)
 name(n);local g=Group.getByName(n)
 assert(g and safe(g,'isExist'),'aircraft group unavailable: '..n)
 local cat=safe(g,'getCategory');assert(cat==0 or cat==1,'group must be an airplane or helicopter')
 local c=safe(g,'getController');assert(c,'controller unavailable');return g,c
end
local function detect(a)
 local _,c=group(a.group);local methods, labels={},{}
 assert(type(a.methods or {})=='table' and #(a.methods or {})<=6,'invalid detection methods')
 local allowed={VISUAL=true,OPTIC=true,RADAR=true,IRST=true,RWR=true,DLINK=true}
 for _,m in ipairs(a.methods or {}) do
  assert(allowed[m] and Controller.Detection[m],'unsupported detection method')
  if not labels[m] then methods[#methods+1]=Controller.Detection[m];labels[m]=true end
 end
 local ordered={};for m in pairs(labels) do ordered[#ordered+1]=m end;table.sort(ordered)
 local key=a.group..':'..table.concat(ordered,',');bounded(A.histories,key,100)
 local h=A.histories[key] or {};A.histories[key]=h
 if a.clearHistory then h={};A.histories[key]=h end
 local age=a.maxAgeSeconds or 300;assert(finite(age) and age>=1 and age<=3600,'invalid history age')
 local now=timer.getTime();for id,r in pairs(h) do
  if now-(r.lastSeenAt or r.sampledAt)>age or now<r.sampledAt then h[id]=nil else r.reportedNow=false;r.stale=true end
 end
 assert(type(c.getDetectedTargets)=='function','getDetectedTargets unavailable')
 local list=c:getDetectedTargets(unpack(methods)) or {};local truncated=false
 for i,d in ipairs(list) do
  if i>200 then truncated=true;break end
  local o=d.object;local id=safe(o,'getID')
  if type(id)=='number' or type(id)=='string' then
   local detected,visible,lastTime,knownType,knownDistance,lastPos,lastVel=true,d.visible,nil,d.type,d.distance,nil,nil
   if type(c.isTargetDetected)=='function' then
    local ok,dd,vv,tt,kt,kd,pp,vp=pcall(c.isTargetDetected,c,o,unpack(methods))
    if ok then detected,visible,lastTime,knownType,knownDistance,lastPos,lastVel=dd,vv,tt,kt,kd,pp,vp end
   end
   if detected==true then
    local r={id=id,identitySource='diagnostic_object_id',detected=true,reportedNow=true,visible=visible,
     typeKnown=knownType,distanceKnown=knownDistance,sampledAt=now,stale=visible~=true}
    if knownType==true then r.typeName=safe(o,'getTypeName') end
    if visible==true then r.lastSeenAt=now
    elseif visible==false then
     r.lastSeenAt=finite(lastTime) and lastTime or nil
     r.lastPosition=vec(lastPos);r.lastVelocity=vec(lastVel)
    end
    -- Never call target getPoint/getVelocity/getCoalition/getName: object handles
    -- expose world truth beyond what a detection result actually establishes.
    if h[tostring(id)] or count(h)<1000 then h[tostring(id)]=r else truncated=true end
   end
  end
 end
 local out={};for _,r in pairs(h) do
  if now-(r.lastSeenAt or r.sampledAt)<=age then out[#out+1]=r end
 end
 table.sort(out,function(x,y) return tostring(x.id)<tostring(y.id) end)
 return {group=a.group,scope='group_controller_knowledge',time=now,methods=ordered,contacts=out,truncated=truncated,
  limitation='No target world position enrichment. Empty methods means any detection method; group knowledge is not individual crew perception.'}
end
local optionIds={roe=0,reaction=1,radar=3,formation=5}
local function options(a)
 local _,c=group(a.group);local g=authored(a.group);local out={}
 local function scan(t,index,depth)
  if type(t)~='table' or depth>8 or #out>=200 then return end
  if t.id=='WrappedAction' then local ac=t.params and t.params.action
   if ac and ac.id=='Option' then out[#out+1]={waypointIndex=index,optionId=ac.params.name,value=ac.params.value,source='authored_waypoint'} end
  elseif t.id=='ComboTask' then for _,child in pairs(t.params and t.params.tasks or {}) do scan(child,index,depth+1) end
  elseif t.id=='ControlledTask' then scan(t.params and t.params.task,index,depth+1) end
 end
 for i,w in pairs(g and g.route and g.route.points or {}) do scan(w.task,i,0) end
 return {group=a.group,mainTask=g and g.task,authoredOptionsAvailable=g~=nil,authoredOptions=out,bridgeWrites=A.writes[a.group] or {},hasTask=safe(c,'hasTask'),
  currentOptionsAvailable=false,taskQueueAvailable=false,limitation='DCS exposes no documented current option/task-queue getter. Authored options may not have run; other scripts may override bridge writes.'}
end
local function setOption(a)
 local _,c=group(a.group);local id=optionIds[a.option];assert(id~=nil,'unsupported aircraft option')
 local v=a.value;assert(finite(v) and v==math.floor(v) and v>=0,'invalid option value')
 if a.option=='formation' then
  assert(v==131073 or v==196609 or v==262145 or v==327681 or v==393217 or v==458753,'unsupported formation')
  assert(safe(Group.getByName(a.group),'getCategory')==0,'formation requires fixed-wing group')
 else assert(v<=(a.option=='reaction' and 5 or a.option=='radar' and 3 or 4),'invalid option value') end
 bounded(A.writes,a.group,100);c:setOption(id,v)
 local list=A.writes[a.group] or {};A.writes[a.group]=list
 list[#list+1]={option=a.option,optionId=id,value=v,time=timer.getTime(),source='bridge_setOption'}
 if #list>50 then table.remove(list,1) end
 return {requested=true,observed=false,group=a.group,optionId=id,value=v}
end
local function taskData(t,g)
 assert(type(t)=='table','task required')
 if t.kind=='orbit' then
  assert(type(t.point)=='table' and finite(t.point.x) and finite(t.point.y),'invalid orbit point')
  assert(t.pattern=='Circle' or t.pattern=='Race-Track','invalid orbit pattern')
  if t.pattern=='Race-Track' then assert(type(t.point2)=='table' and finite(t.point2.x) and finite(t.point2.y) and (t.point2.x~=t.point.x or t.point2.y~=t.point.y),'Race-Track needs distinct point2') end
  assert(finite(t.altitudeMetres) and t.altitudeMetres>0 and t.altitudeMetres<=20000,'invalid orbit altitude')
  assert(finite(t.speedMps) and t.speedMps>0 and t.speedMps<=400,'invalid orbit speed')
  return {id='Orbit',params={point={x=t.point.x,y=t.point.y},point2=t.pattern=='Race-Track' and {x=t.point2.x,y=t.point2.y} or nil,pattern=t.pattern,altitude=t.altitudeMetres,speed=t.speedMps}}
 elseif t.kind=='awacs' or t.kind=='tanker' then
  local original=authored(g);assert(original and original.task==(t.kind=='awacs' and 'AWACS' or 'Refueling'),'service task requires matching authored main task')
  return {id=t.kind=='awacs' and 'AWACS' or 'Tanker',params={}}
 elseif t.kind=='route' then
  assert(type(t.points)=='table' and #t.points>=2 and #t.points<=50,'route requires 2..50 points')
  local points={}
  for i,p in ipairs(t.points) do
   assert(type(p)=='table' and finite(p.x) and finite(p.y) and finite(p.altitudeMetres) and p.altitudeMetres>=0 and p.altitudeMetres<=20000 and finite(p.speedMps) and p.speedMps>0 and p.speedMps<=400,'invalid route point')
   local kind=p.kind or 'turning';assert(kind=='turning' or kind=='landing','invalid route kind')
   local id=p.airdromeId
   if kind=='landing' then assert(i==#t.points and finite(id) and id>0 and id==math.floor(id),'landing needs final waypoint and airfield id') end
   points[i]={x=p.x,y=p.y,alt=p.altitudeMetres,alt_type='BARO',speed=p.speedMps,speed_locked=true,
    type=kind=='landing' and 'Land' or 'Turning Point',action=kind=='landing' and 'Landing' or 'Turning Point',airdromeId=kind=='landing' and id or nil,
    task={id='ComboTask',params={tasks={}}}}
  end
  return {id='Mission',params={route={points=points}}}
 end
 error('unsupported task kind')
end
local function task(a)
 local _,c=group(a.group);local action=a.action
 if action=='inspect' then return options(a) end
 if action=='resume' then
  local s=A.suspensions[a.group];assert(s,'no bridge suspension to resume')
  trigger.action.setUserFlag(s.flag,true);A.suspensions[a.group]=nil
  return {requested=true,observed=false,action=action,stopFlag=s.flag,limitation='Releases the bridge orbit; external task changes may already have replaced it.'}
 elseif action=='suspend' then
  assert(not A.suspensions[a.group],'already suspended by bridge');assert(a.task and a.task.kind=='orbit','suspend requires an explicit orbit')
  bounded(A.suspensions,a.group,100);local t=taskData(a.task,a.group)
  A.serial=A.serial+1;local stop='DCSMCP_AIR_HOLD_'..A.serial
  trigger.action.setUserFlag(stop,false)
  c:pushTask({id='ControlledTask',params={task=t,stopCondition={userFlag=stop,userFlagValue=true}}})
  A.suspensions[a.group]={flag=stop}
  return {requested=true,observed=false,action=action,stopFlag=stop}
 elseif action=='set' or action=='push' then
  assert(not A.suspensions[a.group] or action=='set','resume bridge suspension before pushing another task')
  local t=taskData(a.task,a.group)
  if action=='set' then c:setTask(t);A.suspensions[a.group]=nil else c:pushTask(t) end
 elseif action=='pop' then assert(not A.suspensions[a.group],'use resume to release bridge suspension');c:popTask()
 elseif action=='reset' then c:resetTask();A.suspensions[a.group]=nil
 else error('unsupported task action') end
 return {requested=true,observed=false,action=action,hasTask=safe(c,'hasTask'),limitation='DCS acceptance is not proof of flight execution; set/reset clear native queued tasking.'}
end
local function installEvents()
 if A.handler then return end
 assert(world and world.addEventHandler,'world event monitoring unavailable')
 local wanted={S_EVENT_LAND=true,S_EVENT_TAKEOFF=true,S_EVENT_DEAD=true,S_EVENT_CRASH=true,S_EVENT_BIRTH=true}
 local names={};for n,id in pairs(world.event or {}) do if wanted[n] then names[id]=n end end
 local h={}
 function h:onEvent(e)
  local n=names[e.id];if not n then return end
  local unit=safe(e.initiator,'getName');if not unit then return end
  local tracked=false
  for _,m in pairs(A.monitors) do if m.units[unit] then tracked=true;break end end
  if not tracked then return end
  A.eventSequence=(A.eventSequence or 0)+1
  local id=safe(e.initiator,'getID')
  if n=='S_EVENT_BIRTH' then for _,m in pairs(A.monitors) do if m.units[unit] then
   m.unitSince[unit]=A.eventSequence;m.identities[unit]=id;m.arrivals={}
  end end end
  A.events[#A.events+1]={name=n,unit=unit,unitId=id,time=e.time or timer.getTime(),sequence=A.eventSequence}
  if #A.events>500 then table.remove(A.events,1) end
 end
 world.addEventHandler(h);A.handler=h
end
local function register(a)
 name(a.name);name(a.group);bounded(A.monitors,a.name,50)
 assert(a.role=='AWACS' or a.role=='tanker' or a.role=='transport' or a.role=='reconnaissance','unsupported support role')
 if a.role=='transport' then assert(a.pickup and a.drop,'transport requires pickup/drop areas')
 else assert(not a.pickup and not a.drop and not a.troops and not a.loadedFlag and not a.unloadedFlag,'cargo fields require transport role') end
 for _,k in ipairs({'station','recovery','pickup','drop'}) do zone(a[k]) end
 for _,k in ipairs({'returningFlag','failureFlag','loadedFlag','unloadedFlag'}) do validateFlag(a[k]) end
 if a.troops then name(a.troops) end
 local g=authored(a.group);local live=Group.getByName(a.group)
 assert(g or live,'support group unavailable')
 if live then group(a.group) end
 if a.role=='AWACS' or a.role=='tanker' then assert(g and g.task==(a.role=='AWACS' and 'AWACS' or 'Refueling'),'support role does not match authored main task') end
 local m={config=a,registeredAt=timer.getTime(),registeredSequence=A.eventSequence or 0,units={},identities={},unitSince={},arrivals={}}
 for _,u in pairs(g and g.units or {}) do m.units[u.name]=true end
 for _,u in ipairs(live and safe(live,'getUnits') or {}) do
  local n=safe(u,'getName');if n then m.units[n]=true;m.identities[n]=safe(u,'getID') end
 end
 if a.troops then
  local troops=Group.getByName(a.troops);assert(troops and safe(troops,'getCategory')==2,'troops must be an existing ground group')
  m.troops={};for _,u in ipairs(safe(troops,'getUnits') or {}) do m.troops[safe(u,'getName') or '']=true end
  assert(count(m.troops)>0,'troop group is empty')
 end
 installEvents();A.monitors[a.name]=m
 return {registered=true,name=a.name,since=m.registeredAt,eventMonitoring=true,limitation='Only events after registration are evidence; registration does not change flight tasking.'}
end
local function inspectMonitor(a)
 local m=A.monitors[name(a.name)];assert(m,'unknown monitor');local cfg=m.config;local now=timer.getTime()
 local g=Group.getByName(cfg.group);local units={};local alive,active,air,ground=0,0,0,0
 local at={station=0,recovery=0,pickup=0,drop=0};local seen={}
 for _,u in ipairs(g and safe(g,'getUnits') or {}) do
  local life=safe(u,'getLife');local exists=safe(u,'isExist');local n=safe(u,'getName');local isActive=safe(u,'isActive');local inAir=safe(u,'inAir')
  local id=safe(u,'getID')
  if n and id then
   if m.identities[n] and m.identities[n]~=id then m.arrivals={};m.identityChangedAt=now end
   m.identities[n]=id
  end
  local p=vec(safe(u,'getPoint'));units[#units+1]={name=n,id=id,life=life,active=isActive,inAir=inAir,point=p,fuelFraction=safe(u,'getFuel')}
  if exists and life and life>0 then
   alive=alive+1;if n then seen[n]=true end
   if isActive==true then
    active=active+1;if inAir==true then air=air+1 elseif inAir==false then ground=ground+1 end
    for k in pairs(at) do if inside(p,cfg[k]) then at[k]=at[k]+1 end end
   end
  end
 end
 local landed,dead,lastLand,lastTakeoff={},{},{},{}
 for _,e in ipairs(A.events) do if m.units[e.unit] and e.unitId~=nil and e.unitId==m.identities[e.unit] and e.sequence>(m.unitSince[e.unit] or m.registeredSequence) then
  if e.name=='S_EVENT_LAND' then lastLand[e.unit]=e.time
  elseif e.name=='S_EVENT_TAKEOFF' then lastTakeoff[e.unit]=e.time
  elseif e.name=='S_EVENT_DEAD' or e.name=='S_EVENT_CRASH' then dead[e.unit]=true end
 end end
 for n,t in pairs(lastLand) do if t>=(lastTakeoff[n] or -1) then landed[n]=true end end
 local allDead=count(m.units)>0;for n in pairs(m.units) do if not dead[n] then allDead=false end end
 if active>0 then m.everActive=true end
 local landingConfirmed=active>0 and ground==active and at.recovery==active
 for n in pairs(seen) do if not landed[n] then landingConfirmed=false end end
 local state='unknown';local reasons={}
 if flag(cfg.failureFlag) or (allDead and alive==0) then state='failed';reasons[1]='failure flag or loss events for every registered unit with no live survivors'
 elseif landingConfirmed then state='landed';reasons[1]='landing event, surviving active units on ground inside recovery area'
 elseif active>0 and air==active and flag(cfg.returningFlag) then state='returning';reasons[1]='configured mission return flag'
 elseif active>0 and air==active and at.station==active then state='on_station';reasons[1]='all active survivors airborne inside station area'
 elseif active>0 then state='active';reasons[1]='live active unit observed'
 elseif not m.everActive and authored(cfg.group) and authored(cfg.group).lateActivation then state='planned';reasons[1]='authored late activation; activation not observed' end
 for _,k in ipairs({'pickup','drop'}) do if active>0 and ground==active and at[k]==active and not m.arrivals[k] then m.arrivals[k]=now end end
 local out={name=a.name,group=cfg.group,role=cfg.role,time=now,state=state,evidence=reasons,units=units,
  serviceAvailability='unknown',serviceAvailable=nil,eventEvidenceSince=m.registeredAt,
  eventHistoryGap=A.events[1]~=nil and A.events[1].sequence>m.registeredSequence+1,identityChangedAt=m.identityChangedAt,
  limitation='Observer world snapshot. Station geometry does not prove usable AWACS/tanker service; landing requires a recorded event and recovery area.'}
 if cfg.role=='transport' then
  local delivered,expected=0,count(m.troops or {})
  local tg=cfg.troops and Group.getByName(cfg.troops)
  for _,u in ipairs(tg and safe(tg,'getUnits') or {}) do
   if m.troops and m.troops[safe(u,'getName')] and (safe(u,'getLife') or 0)>0 and safe(u,'isActive')==true and safe(u,'inAir')==false and inside(vec(safe(u,'getPoint')),cfg.drop) then delivered=delivered+1 end
  end
  out.pickupArrived=m.arrivals.pickup~=nil;out.dropArrived=m.arrivals.drop~=nil;out.arrivals=m.arrivals
  out.loading={status=flag(cfg.loadedFlag) and 'scenario_reported' or 'unknown',source=cfg.loadedFlag}
  out.unloading={status=expected>0 and delivered==expected and 'observed_at_destination' or flag(cfg.unloadedFlag) and 'scenario_reported' or 'unknown',source=cfg.unloadedFlag,expected=expected,observedAliveAtDrop=delivered}
  out.recoveryConfirmed=landingConfirmed
  out.cargoManifestAvailable=false
  out.transportLimitation='No documented passenger manifest getter. Missing troops do not prove loading. Destination presence proves location, not that this aircraft carried them. Flags are scenario assertions, not independent cargo verification.'
 end
 return out
end
function A.dispatch(a)
 assert(type(a)=='table','arguments required')
 if a.operation=='detect' then return detect(a)
 elseif a.operation=='options' then return options(a)
 elseif a.operation=='set_option' then return setOption(a)
 elseif a.operation=='task' then return task(a)
 elseif a.operation=='monitor_register' then return register(a)
 elseif a.operation=='monitor_inspect' or a.operation=='transport' then
  if a.operation=='transport' then local m=A.monitors[name(a.name)];assert(m and m.config.role=='transport','transport monitor required') end
  return inspectMonitor(a)
 elseif a.operation=='monitor_remove' then A.monitors[name(a.name)]=nil;return {removed=true,name=a.name}
 end
 error('unsupported aircraft operation')
end
]==]

local handlers = {}

-- This serializer transports data only; the mission module constructs all tasks.
local function aircraftLiteral(v,depth)
 depth=depth or 0;assert(depth<=8,'aircraft arguments too deep')
 local t=type(v)
 if t=='nil' then return 'nil' elseif t=='boolean' then return tostring(v)
 elseif t=='number' then assert(v==v and v~=math.huge and v~=-math.huge,'invalid number');return tostring(v)
 elseif t=='string' then assert(#v<=200,'aircraft string too long');return string.format('%q',v)
 elseif t=='table' then
  local out={};local n=0;for k,value in pairs(v) do
   n=n+1;assert(n<=200,'too many aircraft arguments');assert(type(k)=='string' or type(k)=='number','invalid key')
   out[#out+1]='['..aircraftLiteral(k,depth+1)..']='..aircraftLiteral(value,depth+1)
  end
  return '{'..table.concat(out,',')..'}'
 end
 error('invalid aircraft argument type')
end
function handlers.aircraft_ai(args)
 return runIn('mission',AIRCRAFT_SRC.."\nlocal result=DCSMCP_AIRCRAFT.dispatch("..aircraftLiteral(args)..")\nreturn '{\"ok\":true,\"data\":'..enc(result)..'}'")
end

function handlers.ping()
  return ok({ pong = true, time = os.clock() })
end

--[[
  What the bridge can currently do.

  `missionEnv` is the important field: the mission scripting state only exists
  while a mission runs, so every unit/spawn/message command needs it. Reporting
  it explicitly means a client can say "no mission is running" instead of
  surfacing a confusing timeout.
--]]
function handlers.status()
  -- `missionEnv` is judged by simulation frames, NOT by a dostring probe. A
  -- probe like `return 'ok'` succeeds even when it runs in the GUI state, where
  -- none of the mission API exists, so it reported a reachable environment for
  -- commands that then failed on a nil `coalition`. Frames are the real signal:
  -- the mission scripting state is only serviceable while the sim is ticking.
  local ticking = (os.clock() - lastSimFrame) <= SIM_STALL_S
  local inMission = missionState.phase == "running" or missionState.phase == "loaded"
  local version = {}
  pcall(function()
    if DCS.getVersion then version.dcs = DCS.getVersion() end
  end)
  return ok({
    listening = server ~= nil,
    phase = missionState.phase,
    mission = missionState.name,
    simTicking = ticking,
    missionEnv = inMission and ticking,
    errorCount = #errors,
    loadError = missionState.loadError,
    capabilities = { runtime = true, aircraftAI = 1, flags = true, events = "mission-local native observer; telemetry fallback", rawExec = ALLOW_EXEC },
    version = version.dcs,
  })
end

--[[ Problems the hook recorded, newest last. Pass {"clear":true} to reset. --]]
function handlers.errors(args)
  local out = {}
  for i, e in ipairs(errors) do out[i] = e end
  if args and args.clear then errors = {} end
  return ok({ count = #out, errors = out })
end

function handlers.self()
  return runIn("export", [[
    local d = LoGetSelfData() or {}
    -- LoGetADIPitchBankYaw returns THREE values, not a table. Assigning it to
    -- one local captured the pitch number, and pby[1] then raised
    -- "attempt to index local 'pby' (a number value)" the first time a player
    -- was actually in a cockpit (found live, 2026-11-17).
    local pitch, bank, yaw = LoGetADIPitchBankYaw()
    return '{"ok":true,"data":' .. enc({
      name = d.Name, position = d.LatLongAlt,
      altBar = LoGetAltitudeAboveSeaLevel(), altRad = LoGetAltitudeAboveGroundLevel(),
      pitch = pitch, bank = bank, yaw = yaw,
      ias = LoGetIndicatedAirSpeed(), tas = LoGetTrueAirSpeed(), mach = LoGetMachNumber(),
    }) .. '}'
  ]])
end

function handlers.mission()
  return runIn("mission", [[
    return '{"ok":true,"data":' .. enc({
      time = timer.getTime(), absTime = timer.getAbsTime(),
      theatre = env.mission and env.mission.theatre or nil,
      date = env.mission and env.mission.date or nil,
    }) .. '}'
  ]])
end

function handlers.units(args)
  local coalitionArg = args and args.coalition or "all"
  local body = string.format([[
    local want = %q
    local limit = %d
    local sides = { red = coalition.side.RED, blue = coalition.side.BLUE, neutral = coalition.side.NEUTRAL }
    local out, count, truncated = {}, 0, false
    local function collect(sideName, sideId)
      for _, grp in ipairs(coalition.getGroups(sideId) or {}) do
        for _, u in ipairs(grp:getUnits() or {}) do
          -- `break` only leaves the innermost loop, so the cap needs a flag the
          -- outer loops can see, otherwise every remaining group is still walked.
          if count >= limit then truncated = true; return end
          local p = u:getPoint()
          local ll = { coord.LOtoLL(p) }
          out[#out+1] = { name = u:getName(), type = u:getTypeName(), coalition = sideName,
                          group = grp:getName(), x = p.x, y = p.z, lat = ll[1], lon = ll[2],
                          alt = p.y }
          pcall(function() local orientation = u:getPosition(); out[#out].heading = math.atan2(orientation.x.z, orientation.x.x) end)
          count = count + 1
        end
      end
    end
    for name, id in pairs(sides) do
      if not truncated and (want == "all" or want == name) then collect(name, id) end
    end
    return '{"ok":true,"data":' .. enc({ count = count, truncated = truncated, limit = limit, units = out }) .. '}'
  ]], coalitionArg, MAX_UNITS)
  return runIn("mission", body)
end

-- Read-only bounded snapshot. The observer is installed at mission start, not by reads.
function handlers.runtime(args)
  args = args or {}
  local flags, names = {}, {}
  for i, value in ipairs(args.flags or {}) do
    if i > 100 or type(value) ~= "number" and type(value) ~= "string" or #tostring(value) > 64 then return fail("runtime: invalid flags (max 100)") end
    flags[#flags + 1] = string.format("%q", tostring(value))
  end
  for i, value in ipairs(args.groups or {}) do
    if i > 100 or type(value) ~= "string" or #value > 200 then return fail("runtime: invalid group names") end
    names[#names + 1] = string.format("%q", value)
  end
  local after = tonumber(args.afterSequence) or 0
  if after ~= after or after == math.huge or after < 0 then return fail("runtime: invalid sequence") end

  -- Telemetry is loaded by triggers; on recent DCS builds that is a different
  -- state from the world API. Never reroute world queries to the trigger state.
  local telemetry = '{"events":{},"eventMonitoring":{"available":false}}'
  for _, candidate in ipairs({ "mission", "server" }) do
    local probed, present = pcall(net.dostring_in, candidate,
      "local t=DCSMCP_BRIDGE_EVENTS or DCSMCP; return type(t) == 'table' and type(t.events) == 'table' and 'yes' or 'no'")
    if probed and present == "yes" then
      local source = JSON_ENC_SRC .. string.format([[

        local t = DCSMCP_BRIDGE_EVENTS or DCSMCP
        local out = { events = {}, acceptance = DCSMCP_ACCEPTANCE,
          eventMonitoring = { available = true, source = t.source or "mission_telemetry", sourceState = %q,
            latestSequence = t.eventSequence or 0,
            oldestSequence = t.events[1] and t.events[1].sequence or 0,
            historyGap = t.events[1] ~= nil and %d < t.events[1].sequence - 1 } }
        for _, event in ipairs(t.events) do
          if event.sequence > %d then
            if #out.events >= 200 then out.eventMonitoring.truncated = true; break end
            out.events[#out.events + 1] = event
          end
        end
        return enc(out)
      ]], candidate, math.floor(after), math.floor(after))
      local read, value = pcall(net.dostring_in, candidate, source)
      if read and type(value) == 'string' and value:sub(1,1) == '{' then telemetry = value; break end
    end
  end
  local body = string.format([[
    local requestedFlags, requestedGroups = {%s}, {%s}
    local out = { time = timer.getTime(), theatre = env.mission.theatre, flags = {}, groups = {}, events = {},
      acceptance = DCSMCP_ACCEPTANCE, eventMonitoring = { available = DCSMCP ~= nil and DCSMCP.events ~= nil } }
    for _, flag in ipairs(requestedFlags) do out.flags[flag] = trigger.misc.getUserFlag(flag) end
    local function state(u)
      local result = { name = u:getName(), type = u:getTypeName() }
      for key, method in pairs({ point="getPoint", velocity="getVelocity", life="getLife", life0="getLife0", inAir="inAir", active="isActive" }) do
        local ok, value = pcall(function() return u[method](u) end)
        if ok then result[key] = value end
      end
      return result
    end
    local count = 0
    for _, name in ipairs(requestedGroups) do
      local group = Group.getByName(name)
      local entry = { name = name, exists = group ~= nil and group:isExist(), units = {} }
      if entry.exists then for _, unit in ipairs(group:getUnits() or {}) do
        if count >= 2000 then out.truncated = true; break end
        entry.units[#entry.units + 1] = state(unit); count = count + 1
      end elseif StaticObject and StaticObject.getByName then
        -- Statics (FARP pads, parked aircraft, buildings) are not groups: DCS
        -- keeps them as StaticObjects, so Group.getByName never finds them.
        local static = StaticObject.getByName(name)
        if static and static:isExist() then
          entry.exists, entry.static = true, true
          entry.units[1] = state(static); count = count + 1
        end
      end
      out.groups[#out.groups + 1] = entry
    end
    local telemetry = %q
    return '{"ok":true,"data":' .. enc(out):sub(1,-2) .. ',' .. telemetry:sub(2) .. '}'
  ]], table.concat(flags, ","), table.concat(names, ","), telemetry)
  return runIn("mission", body)
end

function handlers.aircraft(args)
  local coalitionArg = args and args.coalition or "all"
  local body = string.format([[
    local want = %q
    local sides = { red = coalition.side.RED, blue = coalition.side.BLUE, neutral = coalition.side.NEUTRAL }
    local out = {}
    for name, id in pairs(sides) do
      if want == "all" or want == name then
        for _, grp in ipairs(coalition.getGroups(id, Group.Category.AIRPLANE) or {}) do
          for _, u in ipairs(grp:getUnits() or {}) do
            if u:inAir() then
              local p = u:getPoint()
              out[#out+1] = { name = u:getName(), type = u:getTypeName(), coalition = name, alt = p.y }
            end
          end
        end
      end
    end
    return '{"ok":true,"data":' .. enc({ count = #out, aircraft = out }) .. '}'
  ]], coalitionArg)
  return runIn("mission", body)
end

function handlers.message(args)
  local text = tostring((args and args.text) or "")
  local seconds = tonumber((args and args.seconds)) or 20
  local body = string.format([[
    trigger.action.outText(%q, %d, false)
    return '{"ok":true,"data":' .. enc({ shown = true }) .. '}'
  ]], text, math.floor(seconds))
  return runIn("mission", body)
end

function handlers.spawn(args)
  args = args or {}
  local body = string.format([[
    local name = %q
    local unitType = %q
    local lat, lon = %f, %f
    local heading = %f
    local countryId = %d
    local vec = coord.LLtoLO(lat, lon, 0)
    local group = {
      name = name, task = "Ground Nothing",
      route = { points = { { x = vec.x, y = vec.z, alt = 0, type = "Turning Point", action = "Off Road", speed = 0,
        task = { id = "ComboTask", params = { tasks = {} } } } } },
      units = { { name = name .. "-1", type = unitType, x = vec.x, y = vec.z,
                  heading = heading, skill = "Average", playerCanDrive = false } },
    }
    if Group.getByName(name) or Unit.getByName(name .. "-1") then error("Spawn name conflicts with an existing group/unit") end
    local spawned = coalition.addGroup(countryId, Group.Category.GROUND, group)
    if not spawned then error("DCS did not create the group") end
    return '{"ok":true,"data":' .. enc({ spawned = name, x = vec.x, y = vec.z }) .. '}'
  ]],
    tostring(args.name or "MCP Group"),
    tostring(args.type or "M-1 Abrams"),
    tonumber(args.lat) or 0, tonumber(args.lon) or 0,
    tonumber(args.heading) or 0, math.floor(tonumber(args.country) or 2))
  return runIn("mission", body)
end

function handlers.ll2xz(args)
  args = args or {}
  local body = string.format([[
    local v = coord.LLtoLO(%f, %f, %f)
    return '{"ok":true,"data":' .. enc({ x = v.x, y = v.z, z = v.z, alt = v.y }) .. '}'
  ]], tonumber(args.lat) or 0, tonumber(args.lon) or 0, tonumber(args.alt) or 0)
  return runIn("mission", body)
end

function handlers.xz2ll(args)
  args = args or {}
  local body = string.format([[
    local ll = { coord.LOtoLL({ x = %f, y = %f, z = %f }) }
    return '{"ok":true,"data":' .. enc({ lat = ll[1], lon = ll[2] }) .. '}'
  ]], tonumber(args.x) or 0, tonumber(args.alt) or 0, tonumber(args.y) or 0)
  return runIn("mission", body)
end

--[[
  Surface type under a batch of map points.

  This is the only authoritative answer to "is this on land?" — it is DCS's own
  terrain query against the loaded theatre. Ground groups placed on water do not
  error at load; the vehicles simply sit there dead, which reads as broken AI.
  Needs a mission running, because `land` lives in the mission environment.

  Args: { points: [ { x = <north>, y = <east> }, ... ] }
--]]
function handlers.land(args)
  args = args or {}
  local points = args.points
  if type(points) ~= "table" then return fail("land: expected args.points to be a list of {x,y}") end

  -- Every value is forced through tonumber before it reaches the mission state:
  -- these coordinates are interpolated into Lua source, so a string would be an
  -- injection point.
  local parts = {}
  for i, p in ipairs(points) do
    local x, y = tonumber(p.x), tonumber(p.y)
    if not x or not y then return fail("land: point " .. i .. " has a non-numeric x or y") end
    parts[#parts + 1] = string.format("{x=%.3f,y=%.3f}", x, y)
    if #parts >= 500 then break end -- one request must not stall a frame
  end
  if #parts == 0 then return fail("land: no points given") end

  local body = string.format([[
    local names = { [1]="LAND", [2]="SHALLOW_WATER", [3]="WATER", [4]="ROAD", [5]="RUNWAY" }
    local pts = { %s }
    local out = {}
    for i, p in ipairs(pts) do
      local t = land.getSurfaceType(p)
      out[i] = { x = p.x, y = p.y, surface = t, name = names[t] or ("UNKNOWN_" .. tostring(t)),
                 height = land.getHeight(p),
                 land = (t == 1 or t == 4 or t == 5) }
    end
    return '{"ok":true,"data":' .. enc({ count = #out, points = out }) .. '}'
  ]], table.concat(parts, ","))
  return runIn("mission", body)
end

--[[
  Load a mission file, from the menu or over a running one.

  `net.load_mission` is a GUI-environment call, so it works in exactly the state
  where the mission scripting environment does not exist yet — which is the
  whole point: it is how a client gets from "I just wrote a .miz" to "it is
  running" without the user alt-tabbing.

  The result is deliberately not reported as success-or-failure: DCS returns
  before the mission has finished loading, and a mission that fails to open
  reports it through onMissionLoadError / dcs.log, not through this return
  value. Poll `status` afterwards.
--]]
function handlers.loadmission(args)
  args = args or {}
  local path = args.path
  if type(path) ~= "string" or path == "" then return fail("loadmission: args.path is required") end
  if not path:lower():match("%.miz$") then return fail("loadmission: path must end in .miz") end
  if not net.load_mission then return fail("loadmission: net.load_mission is unavailable in this DCS build") end

  -- `net.load_mission` SWAPS the mission on an already-running session; it is the
  -- server mission-rotation call (see DCS's own common.lua, gated behind
  -- DCS.isServer()). From a cold menu there is no running session to load into,
  -- so it silently returns nil and does nothing — no onMissionLoadBegin, no load,
  -- verified on this install from both the GUI render tick and an onSimulationFrame
  -- tick. Refuse rather than report a phantom success. There is no menu->mission
  -- API a Lua hook can drive; a true cold start would need net.start_server, which
  -- hosts an MP server and changes single-player semantics.
  if missionState.phase ~= "running" then
    return fail("loadmission: no mission is running (phase '" .. tostring(missionState.phase) .. "'). " ..
      "net.load_mission only swaps the mission on an already-running session; from the menu it does nothing. " ..
      "Start any mission and fly it, then retry to swap in '" .. path .. "'.")
  end

  if path:find("%z") or path:find("[\r\n]") then return fail("loadmission: invalid path characters") end
  local file = io.open(path, "rb")
  if not file then return fail("loadmission: mission file is not readable") end
  file:close()
  missionState.loadError = nil

  -- Reached only with a mission running, and (via `needsSimThread`) on the
  -- simulation thread — the only context where net.load_mission takes effect.
  local okc, res = pcall(net.load_mission, path)
  if not okc then
    recordError("load_mission failed", res)
    return fail("net.load_mission raised: " .. tostring(res))
  end
  return ok({ requested = path, result = res, note = "loading is asynchronous; poll 'status' for phase" })
end

function handlers.exec(args)
  if not ALLOW_EXEC then
    return fail("Raw exec is disabled. Set ALLOW_EXEC = true in dcs-mcp-hook.lua to enable it.")
  end
  args = args or {}
  local state = tostring(args.env or "mission")
  local code = tostring(args.code or "")
  local out = net.dostring_in(state, code)
  return ok({ result = out })
end

----------------------------------------------------------------------
-- Request dispatch
--
-- Commands that reach into the mission scripting environment must run on the
-- SIMULATION thread.
--
-- DCS is multithreaded: the GUI updater and the simulation frame are different
-- contexts, and `net.dostring_in('mission', ...)` called from the GUI side does
-- not land in the mission's scripting state. It does not fail loudly either —
-- the snippet runs somewhere that simply has no `coalition`, `timer`, `land` or
-- `coord`, so every one of these commands came back with
-- "attempt to index global 'coalition' (a nil value)" while the mission was
-- demonstrably running. Requests for these commands are therefore held until an
-- `onSimulationFrame` tick services them.
----------------------------------------------------------------------
local MISSION_ENV_COMMANDS = {
  mission = true, units = true, aircraft = true, message = true,
  runtime = true, aircraft_ai = true, spawn = true, ll2xz = true, xz2ll = true, land = true, exec = true,
}

local function parseRequest(line)
  local req
  if net and net.json2lua then
    local okd, parsed = pcall(net.json2lua, line)
    if okd then req = parsed end
  end
  if type(req) ~= "table" or not req.cmd then return nil end
  return req
end

local function needsSimThread(req)
  -- `loadmission` does not touch the mission scripting environment, but
  -- `net.load_mission` is still a no-op unless it runs on the simulation thread,
  -- so it is held for `onSimulationFrame` just like the mission-env commands.
  if req.cmd == "loadmission" then return true end
  if not MISSION_ENV_COMMANDS[req.cmd] then return false end
  -- `exec` picks its own state; only the mission one has the threading problem.
  if req.cmd == "exec" then
    local state = req.args and req.args.env or "mission"
    return state == "mission"
  end
  return true
end

local function dispatch(req)
  local handler = handlers[req.cmd]
  if not handler then return fail("Unknown command: " .. tostring(req.cmd)) end
  local okc, res = pcall(handler, req.args)
  if okc then return res end
  return fail(res)
end

----------------------------------------------------------------------
-- Non-blocking TCP server driven by the simulation frame callback
----------------------------------------------------------------------
local function respond(entry, req)
  local okr, res = pcall(dispatch, req)
  entry.response = (okr and res or fail(res)) .. "\n"
  entry.sent = 0
end

local function flushResponse(entry)
  local last, err, partial = entry.sock:send(entry.response, entry.sent + 1)
  entry.sent = last or partial or entry.sent
  if entry.sent >= #entry.response then return true end
  if err and err ~= "timeout" then return true end
  return os.clock() >= entry.deadline
end

--[[
  Service in-flight clients without blocking the simulation.

  Every socket here is non-blocking. A request that has not arrived in full is
  kept in `pending` and retried on the next frame rather than blocking on
  receive: a blocking read stalls the whole DCS frame, which shows up as a
  visible stutter whenever a client connects slowly or dies mid-request.
--]]
local function service(source)
  local now = os.clock()
  local keep = {}
  for _, entry in ipairs(pending) do
    local done = false

    if entry.response then
      done = flushResponse(entry)
    elseif #entry.buffer > MAX_REQUEST_BYTES then
      pcall(function() entry.sock:send(fail("request exceeds 4 MiB") .. "\n") end)
      done = true
    elseif entry.req then
      -- Already read, and held back for the simulation thread. DCS runs Lua 5.1
      -- here, so there is no `goto`/`continue` to skip the read path with.
      if source == "sim" then
        local okr, e = pcall(respond, entry, entry.req)
        if not okr then recordError("response failed", e); done = true
        else done = flushResponse(entry) end
      elseif now - lastSimFrame > SIM_STALL_S then
        -- No simulation frames are arriving: paused, or the mission ended
        -- between reading the request and answering it. Say so rather than
        -- letting the client time out with nothing to go on.
        pcall(function()
          entry.sock:send(fail(
            "'" .. tostring(entry.req.cmd) .. "' must run on the simulation thread, and the simulation is not " ..
            "ticking (paused, or no mission running). net.load_mission and the mission-scripting commands are " ..
            "no-ops from the menu's GUI render thread, so start or unpause a mission and retry.") .. "\n")
        end)
        done = true
      end
    else
      local line, err, partial = entry.sock:receive("*l")
      if line then
        entry.buffer = entry.buffer .. line
        local req = #entry.buffer <= MAX_REQUEST_BYTES and parseRequest(entry.buffer) or nil
        if not req then
          pcall(function() entry.sock:send(fail("Malformed request; expected JSON {\"cmd\":...}") .. "\n") end)
          done = true
        elseif needsSimThread(req) and source ~= "sim" then
          -- Hold it for the simulation tick instead of answering from the GUI
          -- thread, where the mission environment is not visible.
          entry.req = req
        else
          local okr, e = pcall(respond, entry, req)
          if not okr then recordError("response failed", e); done = true
          else done = flushResponse(entry) end
        end
      elseif err == "timeout" then
        entry.buffer = entry.buffer .. (partial or "")
        if now >= entry.deadline then
          pcall(function() entry.sock:send(fail("request timed out before a full line arrived") .. "\n") end)
          done = true
        end
      else
        done = true -- "closed" or a hard error: nothing more is coming
      end
    end

    if done then
      pcall(function() entry.sock:close() end)
    else
      keep[#keep + 1] = entry
    end
  end
  pending = keep
end

local function poll(source)
  if not server then return end
  for _ = 1, MAX_ACCEPTS_PER_FRAME do
    local client = server:accept()
    if not client then break end
    client:settimeout(0) -- never block the simulation frame
    if #pending >= MAX_PENDING then client:close()
    else pending[#pending + 1] = { sock = client, buffer = "", deadline = os.clock() + REQUEST_TIMEOUT_S } end
  end
  service(source)
end

----------------------------------------------------------------------
-- Listener lifetime
--
-- The socket is opened when the hook LOADS, not when a mission starts, so the
-- bridge answers while DCS sits in the main menu or the Mission Editor. That is
-- exactly when a client most needs to ask what went wrong with a mission that
-- would not open.
----------------------------------------------------------------------
local function startServer()
  if server then return true end
  local sock, err = socket.tcp()
  if not sock then
    log.write("DCS-MCP", log.ERROR, "socket.tcp() failed: " .. tostring(err))
    return false
  end
  sock:setoption("reuseaddr", true)

  -- bind/listen failures must be reported: silently ending up with a socket
  -- that never accepts makes every MCP tool time out with no clue why.
  local okBind, bindErr = sock:bind(HOST, PORT)
  if not okBind then
    log.write("DCS-MCP", log.ERROR,
      "cannot bind " .. HOST .. ":" .. PORT .. " (" .. tostring(bindErr) .. "). " ..
      "Another process may already hold the port; the MCP bridge is disabled.")
    sock:close()
    return false
  end
  local okListen, listenErr = sock:listen(8)
  if not okListen then
    log.write("DCS-MCP", log.ERROR, "listen failed: " .. tostring(listenErr))
    sock:close()
    return false
  end
  sock:settimeout(0)
  server = sock
  log.write("DCS-MCP", log.INFO, "hook server listening on " .. HOST .. ":" .. PORT)
  return true
end

local function stopServer()
  for _, entry in ipairs(pending) do pcall(function() entry.sock:close() end) end
  pending = {}
  if server then pcall(function() server:close() end); server = nil end
end

--[[
  Servicing outside a mission.

  `onSimulationFrame` only fires while a mission runs. DCS's GUI state also has a
  per-frame updater (`Gui.AddUpdateCallback`, the one UserHooks.lua drives the
  Mission Editor with) which keeps ticking in the menus. It is not documented as
  a hook API, so it is used defensively: registered only if present, wrapped in
  pcall, and dropped after repeated failures rather than risking the user's UI.
--]]
local guiFailures = 0
-- State probe bookkeeping (defined with the probe below; reset per mission).
local logProbe
local probedSim, probedGui = false, false

local function guiTick()
  if not probedGui and missionState.phase == "running" and logProbe then
    probedGui = true
    logProbe("gui")
  end
  local okp, err = pcall(poll, "gui")
  if okp then
    guiFailures = 0
    return false -- returning true would unregister us
  end
  guiFailures = guiFailures + 1
  recordError("GUI poll error", err)
  if guiFailures >= 10 then
    log.write("DCS-MCP", log.ERROR, "disabling the GUI-side poll after repeated errors")
    return true -- UpdateManager removes an updater that returns true
  end
  return false
end

local function registerGuiTick()
  if type(Gui) ~= "table" or type(Gui.AddUpdateCallback) ~= "function" then
    log.write("DCS-MCP", log.INFO,
      "no GUI updater available; the bridge will only answer while a mission is running")
    return false
  end
  local ok, err = pcall(Gui.AddUpdateCallback, guiTick)
  if not ok then
    log.write("DCS-MCP", log.ERROR, "could not register the GUI poll: " .. tostring(err))
    return false
  end
  log.write("DCS-MCP", log.INFO, "GUI poll registered; the bridge answers in menus too")
  return true
end

--[[
  Which net.dostring_in state holds the mission scripting globals?

  Verified as "mission" on DCS 2.9.25 (July 2026). On 2.9.31 every mission-env
  command came back "attempt to index global 'timer'" with a mission running and
  requests dispatched from onSimulationFrame. This asks each candidate state a
  FIXED, read-only question (which globals exist) and logs the answers, so the
  right state is established from this install rather than guessed. No caller
  supplied code runs here.
--]]
local PROBE_STATES = { "mission", "server", "export", "config" }
local PROBE_SNIPPET = "local t = {} for _, k in ipairs({'timer','coalition','env','trigger','a_do_script'}) do " ..
  "t[#t + 1] = k .. '=' .. type(_G[k]) end return table.concat(t, ',')"

local function probeStates()
  local out = {}
  for _, state in ipairs(PROBE_STATES) do
    local okp, res = pcall(net.dostring_in, state, PROBE_SNIPPET)
    out[state] = okp and tostring(res) or ("error: " .. tostring(res))
  end
  return out
end

function logProbe(source)
  local okp, result = pcall(probeStates)
  if not okp then
    log.write("DCS-MCP", log.ERROR, "state probe (" .. source .. ") failed: " .. tostring(result))
    return
  end
  for _, state in ipairs(PROBE_STATES) do
    log.write("DCS-MCP", log.INFO, "state probe source=" .. source .. " state=" .. state .. " -> " .. result[state])
  end
end

-- Read-only: an airbase's parking spots as DCS itself reports them, so the
-- bundled (pydcs-derived) parking data can be checked against the running game.
function handlers.parking(args)
  local name = args and args.airbase
  if type(name) ~= "string" or #name == 0 or #name > 100 then return fail("parking: airbase name required") end
  return runIn("mission", string.format([[
    local ab = Airbase.getByName(%q)
    if not ab then return '{"ok":false,"error":"no airbase named ' .. %q .. '"}' end
    local spots = {}
    for _, p in ipairs(ab:getParking() or {}) do
      if #spots >= 500 then break end
      spots[#spots + 1] = { term = p.Term_Index, term0 = p.Term_Index_0, termType = p.Term_Type,
        x = p.vTerminalPos and p.vTerminalPos.x, y = p.vTerminalPos and p.vTerminalPos.y, z = p.vTerminalPos and p.vTerminalPos.z, toAC = p.TO_AC, distRW = p.fDistToRW }
    end
    local desc = ab:getDesc() or {}
    return '{"ok":true,"data":' .. enc({ airbase = %q, id = ab:getID(), displayName = desc.displayName, spots = spots }) .. '}'
  ]], name, name, name))
end
MISSION_ENV_COMMANDS.parking = true

function handlers.probe()
  return ok({ states = probeStates() })
end
MISSION_ENV_COMMANDS.probe = true

--[[
  Every airbase of the RUNNING theatre as DCS itself reports it: id, name, callsign,
  category, owning coalition, position (map metres and lat/lon), runways and parking spots.

  This is the only way to get airfield ids, coordinates and parking for a theatre the
  bundled (pydcs-derived) catalogue has never heard of — Iraq, Marianas WWII — because
  that data lives in the terrain's binary files, not in any Lua the server can read. The
  client turns one or more of these answers into an offline "airbase pack".

  Paged on purpose: a full theatre with parking is megabytes, and one response must not
  stall a simulation frame. Args: { from = 1, limit = 8, parking = true, runways = true }
--]]
function handlers.airbases(args)
  args = args or {}
  local from = math.max(1, math.floor(tonumber(args.from) or 1))
  local limit = math.max(1, math.min(math.floor(tonumber(args.limit) or 8), 20))
  local wantParking = args.parking ~= false
  local wantRunways = args.runways ~= false
  return runIn("mission", string.format([[
    local cats = { [0] = "AIRDROME", [1] = "HELIPAD", [2] = "SHIP" }
    local all = world.getAirbases() or {}
    local from, limit = %d, %d
    local out, spots = {}, 0
    for idx = from, math.min(#all, from + limit - 1) do
      local ab = all[idx]
      if ab then
        local okp, entry = pcall(function()
          local p = ab:getPoint()
          local desc = ab:getDesc() or {}
          local ll = { coord.LOtoLL(p) }
          local e = { index = idx, id = ab:getID(), name = ab:getName(),
            callsign = ab:getCallsign(), displayName = desc.displayName,
            category = cats[desc.category] or tostring(desc.category),
            coalition = ab:getCoalition(),
            x = p.x, y = p.z, alt = p.y, lat = ll[1], lon = ll[2] }
          if %s then
            local okr, rws = pcall(function() return ab:getRunways() end)
            if okr and type(rws) == "table" then
              e.runways = {}
              for _, r in ipairs(rws) do
                e.runways[#e.runways + 1] = { name = r.Name or r.name, course = r.course,
                  length = r.length, width = r.width,
                  x = r.position and r.position.x, y = r.position and r.position.z }
              end
            end
          end
          if %s then
            local okq, park = pcall(function() return ab:getParking(false) end)
            if okq and type(park) == "table" then
              e.parking = {}
              for _, s in ipairs(park) do
                if #e.parking >= 400 or spots >= 2000 then break end
                e.parking[#e.parking + 1] = { term = s.Term_Index, term0 = s.Term_Index_0,
                  termType = s.Term_Type, toAC = s.TO_AC, distRW = s.fDistToRW,
                  x = s.vTerminalPos and s.vTerminalPos.x, y = s.vTerminalPos and s.vTerminalPos.z,
                  alt = s.vTerminalPos and s.vTerminalPos.y }
                spots = spots + 1
              end
            end
          end
          return e
        end)
        if okp then out[#out + 1] = entry end
      end
    end
    local theatre = nil
    if env and env.mission then theatre = env.mission.theatre end
    return '{"ok":true,"data":' .. enc({ theatre = theatre, total = #all, from = from,
      returned = #out, parkingSpots = spots, airbases = out }) .. '}'
  ]], from, limit, wantRunways and "true" or "false", wantParking and "true" or "false"))
end
MISSION_ENV_COMMANDS.airbases = true

--[[
  Roads and railways, from DCS's own road graph.

  `land.getClosestPointOnRoads(kind, x, y)` snaps a point to the nearest road/railway
  node, and `land.findPathOnRoads(kind, x1, y1, x2, y2)` returns the route between two
  points along it. There is no offline equivalent: the road graph is terrain data the
  server cannot read, so this is the only honest answer to "put this convoy on a road".

  Args: { kind = "roads"|"railroads", points = [{x,y}, ...] }     -> snapped points
         { kind = ..., from = {x,y}, to = {x,y} }                 -> path along the graph
--]]
function handlers.roads(args)
  args = args or {}
  local kind = tostring(args.kind or "roads")
  if kind ~= "roads" and kind ~= "railroads" then return fail("roads: kind must be 'roads' or 'railroads'") end
  if args.from and args.to then
    local x1, y1 = tonumber(args.from.x), tonumber(args.from.y)
    local x2, y2 = tonumber(args.to.x), tonumber(args.to.y)
    if not (x1 and y1 and x2 and y2) then return fail("roads: from/to need numeric x and y") end
    return runIn("mission", string.format([[
      local path = land.findPathOnRoads(%q, %.3f, %.3f, %.3f, %.3f)
      local out = {}
      if type(path) == "table" then
        for i, p in ipairs(path) do
          if i > 1000 then break end
          out[#out + 1] = { x = p.x, y = p.y, surface = land.getSurfaceType({ x = p.x, y = p.y }) }
        end
      end
      return '{"ok":true,"data":' .. enc({ kind = %q, found = #out > 0, count = #out, path = out }) .. '}'
    ]], kind, x1, y1, x2, y2, kind))
  end
  local points = args.points
  if type(points) ~= "table" then return fail("roads: give either points (to snap) or from and to (for a path)") end
  local parts = {}
  for i, p in ipairs(points) do
    local x, y = tonumber(p.x), tonumber(p.y)
    if not x or not y then return fail("roads: point " .. i .. " has a non-numeric x or y") end
    parts[#parts + 1] = string.format("{x=%.3f,y=%.3f}", x, y)
    if #parts >= 200 then break end
  end
  if #parts == 0 then return fail("roads: no points given") end
  return runIn("mission", string.format([[
    local pts = { %s }
    local out = {}
    for i, p in ipairs(pts) do
      local rx, ry = land.getClosestPointOnRoads(%q, p.x, p.y)
      if rx and ry then
        local dx, dy = rx - p.x, ry - p.y
        out[i] = { x = p.x, y = p.y, roadX = rx, roadY = ry,
          distance = math.sqrt(dx * dx + dy * dy),
          surface = land.getSurfaceType({ x = rx, y = ry }), height = land.getHeight({ x = rx, y = ry }) }
      else
        out[i] = { x = p.x, y = p.y, roadX = nil, roadY = nil }
      end
    end
    return '{"ok":true,"data":' .. enc({ kind = %q, count = #out, points = out }) .. '}'
  ]], table.concat(parts, ","), kind, kind))
end
MISSION_ENV_COMMANDS.roads = true

--[[
  Line of sight and terrain profile between point pairs (land.isVisible / land.getIP).

  This is DCS's own terrain intersection against the loaded theatre: bare earth plus
  whatever the engine includes in its height field. It is NOT a radar or sensor model —
  no RCS, no propagation, no clutter — and must never be reported as detection.

  Args: { pairs = [ { from = {x,y,alt}, to = {x,y,alt} }, ... ] }
--]]
function handlers.los(args)
  args = args or {}
  local list = args.pairs
  if type(list) ~= "table" then return fail("los: expected args.pairs as a list of {from,to}") end
  local parts = {}
  for i, pair in ipairs(list) do
    local f, t = pair.from, pair.to
    if type(f) ~= "table" or type(t) ~= "table" then return fail("los: pair " .. i .. " needs from and to") end
    local fx, fy, ft = tonumber(f.x), tonumber(f.y), tonumber(f.alt)
    local tx, ty, tt = tonumber(t.x), tonumber(t.y), tonumber(t.alt)
    if not (fx and fy and tx and ty) then return fail("los: pair " .. i .. " has a non-numeric x or y") end
    parts[#parts + 1] = string.format("{fx=%.3f,fy=%.3f,fa=%s,tx=%.3f,ty=%.3f,ta=%s}",
      fx, fy, ft and string.format("%.3f", ft) or "nil", tx, ty, tt and string.format("%.3f", tt) or "nil")
    if #parts >= 100 then break end
  end
  if #parts == 0 then return fail("los: no pairs given") end
  return runIn("mission", string.format([[
    local pairs_ = { %s }
    local out = {}
    for i, p in ipairs(pairs_) do
      local fromAlt = p.fa or (land.getHeight({ x = p.fx, y = p.fy }) + 2)
      local toAlt = p.ta or (land.getHeight({ x = p.tx, y = p.ty }) + 2)
      local a = { x = p.fx, y = fromAlt, z = p.fy }
      local b = { x = p.tx, y = toAlt, z = p.ty }
      local dx, dy, dz = b.x - a.x, b.y - a.y, b.z - a.z
      local len = math.sqrt(dx * dx + dy * dy + dz * dz)
      local visible = land.isVisible(a, b)
      local entry = { from = { x = p.fx, y = p.fy, alt = fromAlt }, to = { x = p.tx, y = p.ty, alt = toAlt },
        distance = len, visible = visible }
      if not visible and len > 0 then
        local dir = { x = dx / len, y = dy / len, z = dz / len }
        local ip = land.getIP(a, dir, len)
        if ip then
          entry.blockedAt = { x = ip.x, y = ip.z, alt = ip.y }
          local bx, bz = ip.x - a.x, ip.z - a.z
          entry.blockedAtMetres = math.sqrt(bx * bx + bz * bz)
        end
      end
      out[i] = entry
    end
    return '{"ok":true,"data":' .. enc({ count = #out, pairs = out,
      note = "DCS terrain intersection (land.isVisible/getIP). Geometry only: not a sensor or radar model." }) .. '}'
  ]], table.concat(parts, ",")))
end
MISSION_ENV_COMMANDS.los = true

--[[
  Open ground: grid-sample an area for spots that are land, flat enough, and clear of
  scenery objects (buildings, trees DCS models as objects).

  Surfaces come from land.getSurfaceType, slope from land.getHeight of the neighbours,
  and obstructions from world.searchObjects(Object.Category.SCENERY, box). An object DCS
  does not model as a scenery object (some vegetation) is invisible to this, so a clear
  spot is "nothing found", not a guarantee.

  Args: { centre = {x,y}, radius = <m>, spacing = <m>, clearance = <m>,
          maxSlopeDegrees = <deg>, limit = <n> }
--]]
function handlers.clearspot(args)
  args = args or {}
  local c = args.centre or args.center
  local cx, cy = tonumber(c and c.x), tonumber(c and c.y)
  if not (cx and cy) then return fail("clearspot: centre needs numeric x and y") end
  local radius = math.min(math.max(tonumber(args.radius) or 1000, 50), 20000)
  local spacing = math.min(math.max(tonumber(args.spacing) or 100, 10), 2000)
  local clearance = math.min(math.max(tonumber(args.clearance) or 30, 1), 500)
  local maxSlope = math.min(math.max(tonumber(args.maxSlopeDegrees) or 10, 0.5), 60)
  local limit = math.min(math.max(math.floor(tonumber(args.limit) or 10), 1), 100)
  local side = math.floor((2 * radius) / spacing) + 1
  if side * side > 4096 then return fail("clearspot: radius/spacing would sample " .. (side * side) .. " nodes; raise spacing or shrink radius (4096 max)") end
  return runIn("mission", string.format([[
    local cx, cy, radius, spacing = %.3f, %.3f, %.3f, %.3f
    local clearance, maxSlope, limit = %.3f, %.3f, %d
    local objects = {}
    local vol = { id = world.VolumeType.BOX, params = { min = { x = cx - radius, y = land.getHeight({x=cx,y=cy}) - 500, z = cy - radius },
                                                        max = { x = cx + radius, y = land.getHeight({x=cx,y=cy}) + 2000, z = cy + radius } } }
    local okSearch = pcall(world.searchObjects, Object.Category.SCENERY, vol, function(obj)
      if #objects >= 2000 then return false end
      local okp, p = pcall(function() return obj:getPoint() end)
      if okp and p then objects[#objects + 1] = { x = p.x, y = p.z } end
      return true
    end)
    local candidates = {}
    local steps = math.floor(radius / spacing)
    for i = -steps, steps do
      for j = -steps, steps do
        local x, y = cx + i * spacing, cy + j * spacing
        local dx, dy = x - cx, y - cy
        if dx * dx + dy * dy <= radius * radius then
          local surface = land.getSurfaceType({ x = x, y = y })
          if surface == 1 or surface == 4 or surface == 5 then
            local h = land.getHeight({ x = x, y = y })
            local probe = spacing / 2
            local hx = land.getHeight({ x = x + probe, y = y })
            local hy = land.getHeight({ x = x, y = y + probe })
            local slope = math.deg(math.atan(math.max(math.abs(hx - h), math.abs(hy - h)) / probe))
            if slope <= maxSlope then
              local nearest = nil
              for _, o in ipairs(objects) do
                local ox, oy = o.x - x, o.y - y
                local d = math.sqrt(ox * ox + oy * oy)
                if not nearest or d < nearest then nearest = d end
              end
              if not nearest or nearest >= clearance then
                candidates[#candidates + 1] = { x = x, y = y, height = h, surface = surface,
                  slopeDegrees = slope, nearestObjectMetres = nearest,
                  distanceFromCentre = math.sqrt(dx * dx + dy * dy) }
              end
            end
          end
        end
      end
    end
    table.sort(candidates, function(a, b) return a.distanceFromCentre < b.distanceFromCentre end)
    local out = {}
    for i = 1, math.min(#candidates, limit) do out[i] = candidates[i] end
    return '{"ok":true,"data":' .. enc({ centre = { x = cx, y = cy }, radius = radius, spacing = spacing,
      clearance = clearance, maxSlopeDegrees = maxSlope, sceneryObjects = #objects,
      searched = okSearch, found = #candidates, returned = #out, spots = out,
      note = "Land/slope from land.getSurfaceType+getHeight; obstructions from world.searchObjects(SCENERY). Objects DCS does not model as scenery are not seen." }) .. '}'
  ]], cx, cy, radius, spacing, clearance, maxSlope, limit))
end
MISSION_ENV_COMMANDS.clearspot = true

local callbacks = {}

function callbacks.onSimulationStart()
  missionState.phase = "running"
  probedSim, probedGui = false, false
  resetScriptingState()
  observerReady, observerAttempts = false, 0
  observerEpoch = observerEpoch + 1
  startServer() -- no-op when the load-time start already succeeded
end

function callbacks.onSimulationFrame()
  lastSimFrame = os.clock()
  if not observerReady and observerAttempts < 5 then
    observerAttempts = observerAttempts + 1
    local okObserver, ready = pcall(installEventObserver)
    observerReady = okObserver and ready
  end
  if not probedSim and missionState.phase == "running" then
    probedSim = true
    logProbe("sim")
  end
  local okp, err = pcall(poll, "sim")
  if not okp then recordError("poll error", err) end
end

function callbacks.onSimulationStop()
  missionState.phase = "menu"
  -- The listener deliberately outlives the mission so a client can still ask
  -- what happened after a mission ends or fails to load.
end

function callbacks.onMissionLoadBegin()
  missionState.phase = "loading"
  missionState.name = (DCS.getMissionName and select(1, pcall(DCS.getMissionName))) and DCS.getMissionName() or nil
  missionState.loadError = nil
end

function callbacks.onMissionLoadEnd()
  missionState.phase = "loaded"
end

function callbacks.onMissionLoadError(message)
  missionState.phase = "error"
  missionState.loadError = tostring(message)
  recordError("mission load error", message)
end

DCS.setUserCallbacks(callbacks)

startServer()
registerGuiTick()
