--[[
  DCS-MCP mission-side telemetry.

  Runs in the MISSION scripting environment, loaded last by the "Load Scripts"
  MISSION START trigger (see src/miz/frameworks.ts). Everything it knows is
  written to Saved Games/DCS/Logs/dcs.log with a single fixed prefix, because
  that is the one error channel that keeps working when the mission is loading,
  when a script blows up, and when no mission is running at all. src/dcs/log.ts
  reads the same file, so the MCP side sees all of this without needing a new
  hook command or a DCS restart.

  Every line is `[DCSMCP] <KIND> key=value ...`, so it greps cleanly and the
  values never need quoting rules beyond "no spaces in a value".

  Nothing here may throw. A telemetry script that raises inside a world event
  handler takes the handler down with it and DCS silently stops delivering
  events, which looks exactly like "the mission is fine but nothing happens".
  Every entry point is therefore wrapped in pcall.
]]

DCSMCP = DCSMCP or {}

local PREFIX = "[DCSMCP] "
local STATE_INTERVAL = 10 -- seconds between player state samples
local IADS_INTERVAL = 30 -- seconds between IADS network samples

---------------------------------------------------------------------------
-- Logging
---------------------------------------------------------------------------

local function log(kind, msg)
  env.info(PREFIX .. kind .. " " .. tostring(msg))
end

local function logError(kind, msg)
  -- env.error also lands in dcs.log, tagged ERROR, so dcs_get_log_errors sees it.
  env.error(PREFIX .. kind .. " " .. tostring(msg))
end

DCSMCP.log = log

--- Round to whole metres. Log lines are for humans and greps, not for replay.
local function r(n)
  if type(n) ~= "number" then return "nil" end
  return string.format("%.0f", n)
end

--- Values must never contain spaces: the log format is space-separated pairs.
local function safe(s)
  return (tostring(s):gsub("%s+", "_"))
end

---------------------------------------------------------------------------
-- Terrain audit: no ground group may sit on water
---------------------------------------------------------------------------

local SURFACE_NAMES = {
  [1] = "LAND",
  [2] = "SHALLOW_WATER",
  [3] = "WATER",
  [4] = "ROAD",
  [5] = "RUNWAY",
}

--- Surface types a ground unit may legally spawn on.
local SURFACE_OK = { LAND = true, ROAD = true, RUNWAY = true }

--[[
  Report the surface under every ground unit in the mission.

  This is the only authoritative land/water answer: it is DCS's own terrain
  query on the actual loaded theatre. A group placed on WATER does not error at
  load — the vehicles simply sink or float dead, which reads as "the AI is
  broken", so it has to be checked explicitly and reported as an ERROR line.
]]
local function auditTerrain()
  local bad, total = 0, 0
  for _, side in pairs({ coalition.side.RED, coalition.side.BLUE, coalition.side.NEUTRAL }) do
    for _, group in pairs(coalition.getGroups(side, Group.Category.GROUND) or {}) do
      if group:isExist() then
        local groupName = group:getName()
        for _, unit in pairs(group:getUnits() or {}) do
          local p = unit:getPoint()
          local surface = land.getSurfaceType({ x = p.x, y = p.z })
          local name = SURFACE_NAMES[surface] or ("UNKNOWN_" .. tostring(surface))
          total = total + 1
          if SURFACE_OK[name] then
            log("TERRAIN", string.format(
              "group=%s unit=%s x=%s z=%s surface=%s ok=1",
              safe(groupName), safe(unit:getName()), r(p.x), r(p.z), name))
          else
            bad = bad + 1
            logError("TERRAIN_WATER", string.format(
              "group=%s unit=%s x=%s z=%s surface=%s ok=0",
              safe(groupName), safe(unit:getName()), r(p.x), r(p.z), name))
          end
        end
      end
    end
  end
  log("TERRAIN_SUMMARY", string.format("units=%d onWater=%d", total, bad))
end

---------------------------------------------------------------------------
-- Framework presence
---------------------------------------------------------------------------

--[[
  Report which frameworks actually reached the mission environment.

  Load order is the classic failure here: Skynet initialises against MIST, and
  if the DO SCRIPT FILE actions ran in the wrong order the mission still loads,
  Skynet is just silently absent. Naming each global explicitly turns that into
  a visible line instead of a mystery.
]]
local function auditFrameworks()
  local checks = {
    { name = "MIST", present = (mist ~= nil), version = mist and mist.majorVersion and
      (tostring(mist.majorVersion) .. "." .. tostring(mist.minorVersion) .. "." .. tostring(mist.build)) },
    { name = "MOOSE", present = (BASE ~= nil and _DATABASE ~= nil), version = _G.MOOSE_VERSION },
    { name = "SKYNET", present = (SkynetIADS ~= nil), version = SkynetIADS and SkynetIADS.VERSION },
  }
  for _, c in ipairs(checks) do
    if c.present then
      log("FRAMEWORK", string.format("name=%s loaded=1 version=%s", c.name, safe(c.version or "unknown")))
    else
      logError("FRAMEWORK", string.format("name=%s loaded=0", c.name))
    end
  end
end

---------------------------------------------------------------------------
-- World events
---------------------------------------------------------------------------

local EVENT_NAMES = {}
for name, id in pairs(world.event) do
  EVENT_NAMES[id] = name
end

local function describe(obj)
  if obj == nil then return "none" end
  local okName, name = pcall(function() return obj:getName() end)
  if not okName or name == nil then return "unknown" end
  return safe(name)
end

local handler = {}

function handler:onEvent(event)
  local okRun, err = pcall(function()
    local id = event.id
    local name = EVENT_NAMES[id] or ("EVENT_" .. tostring(id))

    -- The high-rate events (S_EVENT_TOOK_CONTROL, refuelling, marks) drown the
    -- log and tell us nothing about mission flow, so only the ones that answer
    -- "what happened and to whom" are logged.
    local interesting = {
      S_EVENT_SHOT = true, S_EVENT_HIT = true, S_EVENT_KILL = true,
      S_EVENT_DEAD = true, S_EVENT_CRASH = true, S_EVENT_EJECTION = true,
      S_EVENT_TAKEOFF = true, S_EVENT_LAND = true, S_EVENT_PILOT_DEAD = true,
      S_EVENT_BIRTH = true, S_EVENT_ENGINE_STARTUP = true,
      S_EVENT_MISSION_END = true, S_EVENT_PLAYER_ENTER_UNIT = true,
      S_EVENT_SHOOTING_START = true, S_EVENT_BASE_CAPTURED = true,
    }
    if not interesting[name] then return end

    log("EVT", string.format(
      "t=%s ev=%s initiator=%s target=%s weapon=%s",
      r(event.time or timer.getTime()), name,
      describe(event.initiator), describe(event.target), describe(event.weapon)))
  end)
  if not okRun then
    logError("EVT_HANDLER_FAILED", safe(tostring(err)))
  end
end

---------------------------------------------------------------------------
-- Periodic samples
---------------------------------------------------------------------------

--- Log every player-controlled aircraft's state, once per STATE_INTERVAL.
local function samplePlayers()
  for _, side in pairs({ coalition.side.BLUE, coalition.side.RED }) do
    for _, group in pairs(coalition.getGroups(side, Group.Category.AIRPLANE) or {}) do
      if group:isExist() then
        for _, unit in pairs(group:getUnits() or {}) do
          if unit:getPlayerName() then
            local p = unit:getPoint()
            local v = unit:getVelocity()
            local speed = math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
            local agl = p.y - land.getHeight({ x = p.x, y = p.z })
            log("STATE", string.format(
              "t=%s player=%s unit=%s x=%s z=%s altMSL=%s altAGL=%s speedMps=%s life=%s",
              r(timer.getTime()), safe(unit:getPlayerName()), safe(unit:getName()),
              r(p.x), r(p.z), r(p.y), r(agl), r(speed), r(unit:getLife())))
          end
        end
      end
    end
  end
end

--[[
  Log the IADS network state.

  Skynet exposes its sites through the instance the setup script left in a
  global. Which global that is belongs to the mission's setup script, so the
  names are looked up rather than assumed, and a mission with no IADS simply
  logs nothing instead of erroring every 30 seconds.
]]
local function sampleIADS()
  for _, globalName in ipairs({ "redIADS", "blueIADS" }) do
    local iads = _G[globalName]
    if iads and iads.getSAMSites then
      local live, dark, cut, destroyed = 0, 0, 0, 0
      -- getSAMSites/getEarlyWarningRadars return a SkynetIADSTableDelegator, not
      -- a plain array: it is a proxy that also carries its own `__index` field.
      -- `pairs` therefore yields one extra, non-site value and calling a site
      -- method on it fails with "attempt to call method 'isDestroyed'". ipairs
      -- walks 1..n and sees only the real elements.
      for _, site in ipairs(iads:getSAMSites() or {}) do
        local isDead = site:isDestroyed()
        local powered = site:hasWorkingPowerSource()
        local connected = site:hasActiveConnectionNode()
        local active = site:isActive()

        if isDead then destroyed = destroyed + 1
        elseif not powered or not connected then cut = cut + 1
        elseif active then live = live + 1
        else dark = dark + 1 end

        -- Per-site detail is what makes "the SAM never shot at me" answerable:
        -- dark-but-healthy, cut off from the net, and out of ammo look identical
        -- from the cockpit.
        log("IADS_SITE", string.format(
          "t=%s net=%s site=%s nato=%s active=%s dead=%s power=%s link=%s radar=%s ammo=%s harmDef=%s auto=%s",
          r(timer.getTime()), globalName, safe(site:getDCSName()), safe(site:getNatoName()),
          tostring(active), tostring(isDead), tostring(powered), tostring(connected),
          tostring(site:hasWorkingRadar()), tostring(site:hasRemainingAmmo()),
          tostring(site:isDefendingHARM()), tostring(site:getAutonomousState())))
      end
      local ew = #(iads:getEarlyWarningRadars() or {})
      log("IADS", string.format(
        "t=%s net=%s samLive=%d samDark=%d samCut=%d samDead=%d ewr=%d",
        r(timer.getTime()), globalName, live, dark, cut, destroyed, ew))
    end
  end
end

---------------------------------------------------------------------------
-- Trigger instrumentation
---------------------------------------------------------------------------

--[[
  Called from a trigger's DO SCRIPT action: `DCSMCP.trig('name')`.

  Mission triggers leave no trace of their own in the log, so a trigger that
  never fires and a trigger that fires into a broken action look identical from
  the outside. This makes the firing itself visible.
]]
function DCSMCP.trig(name, detail)
  local okRun, err = pcall(function()
    log("TRIG", string.format("t=%s name=%s detail=%s",
      r(timer.getTime()), safe(name), safe(detail or "-")))
  end)
  if not okRun then logError("TRIG_LOG_FAILED", safe(tostring(err))) end
end

---------------------------------------------------------------------------
-- Start
---------------------------------------------------------------------------

local function scheduleEvery(fn, interval)
  timer.scheduleFunction(function(_, nextTime)
    local okRun, err = pcall(fn)
    if not okRun then logError("SAMPLE_FAILED", safe(tostring(err))) end
    return nextTime + interval
  end, nil, timer.getTime() + interval)
end

local function scheduleOnce(fn, delay)
  timer.scheduleFunction(function()
    local okRun, err = pcall(fn)
    if not okRun then logError("SAMPLE_FAILED", safe(tostring(err))) end
    return nil
  end, nil, timer.getTime() + delay)
end

local function start()
  log("BOOT", string.format("t=%s mission=%s", r(timer.getTime()), safe(env.mission.theatre or "?")))
  auditFrameworks()
  -- The terrain audit runs a few seconds in, not at t=0: this script is the last
  -- action of the MISSION START trigger, and querying units before the world has
  -- finished placing them reports an empty mission rather than a clean one.
  scheduleOnce(auditTerrain, 5)
  world.addEventHandler(handler)
  scheduleEvery(samplePlayers, STATE_INTERVAL)
  scheduleEvery(sampleIADS, IADS_INTERVAL)
  log("READY", "telemetry=1")
end

local okStart, startErr = pcall(start)
if not okStart then
  logError("BOOT_FAILED", safe(tostring(startErr)))
end
