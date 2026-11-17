-- Loads the DCS-MCP GUI hook under DCS's own Lua with the DCS globals stubbed,
-- then drives its callbacks. A syntax check cannot catch runtime-only breakage
-- such as calling `load(string)`, which is valid 5.2+ but fails on the Lua 5.1
-- that DCS actually runs -- and DCS reports that as one line in dcs.log while
-- the bridge silently never comes up.

local hookPath = ...

-- --- DCS environment stubs -------------------------------------------------

log = {
  INFO = "INFO", ERROR = "ERROR", WARNING = "WARNING",
  write = function(src, level, msg) print("LOG " .. tostring(level) .. " " .. tostring(msg)) end,
}

local sent = {}

-- Minimal luasocket stand-in: one client delivering one request line.
local queuedRequest = nil
local clientSock = {
  settimeout = function() end,
  receive = function() local r = queuedRequest; queuedRequest = nil; return r or nil, "closed" end,
  send = function(_, s, first) sent[#sent + 1] = s:sub(first or 1); return #s end,
  close = function() end,
}
local serverSock = {
  setoption = function() return true end,
  bind = function() return true end,
  listen = function() return true end,
  settimeout = function() end,
  accept = function() if queuedRequest then return clientSock end return nil end,
  close = function() end,
}
package.loaded["socket"] = { tcp = function() return serverSock end }

-- A known readable virtual mission for the load guard; all other paths use real io.
local originalOpen = io.open
io.open = function(path, mode)
  if path == "C:/m/swap.miz" then return { close = function() end } end
  return originalOpen(path, mode)
end
local loadMissionCalls = {}

-- --- mission scripting environment stub ------------------------------------
--
-- The hook ships Lua into the mission state as a STRING built with
-- string.format, so a syntax error or a bad API call in one of those snippets
-- is invisible to a parse of the hook file and only shows up in a flown
-- mission. So the dostring_in stub COMPILES each snippet with loadstring (the
-- Lua 5.1 API DCS has) and runs it against stubs of the DCS mission API. Flat
-- terrain, one scenery object and two airbases are enough to exercise every
-- branch the structured commands take.

local SCENERY_AT = { x = 50, y = 0 }

local function fakeAirbase(id, name, x, y)
  return {
    getPoint = function() return { x = x, y = 20, z = y } end,
    getID = function() return id end,
    getName = function() return name end,
    getCallsign = function() return name:upper() end,
    getCoalition = function() return 2 end,
    getDesc = function() return { displayName = name .. " Intl", category = 0 } end,
    getRunways = function() return { { Name = "09-27", course = 1.57, length = 3000, width = 45, position = { x = x, y = 20, z = y } } } end,
    getParking = function()
      return {
        { Term_Index = 10, Term_Index_0 = 10, Term_Type = 104, TO_AC = true, fDistToRW = 900,
          vTerminalPos = { x = x + 100, y = 20, z = y + 50 } },
        { Term_Index = 11, Term_Index_0 = 11, Term_Type = 40, TO_AC = false, fDistToRW = 1200,
          vTerminalPos = { x = x + 120, y = 20, z = y + 70 } },
      }
    end,
  }
end

local function missionEnvironment()
  local E = {}
  for _, k in ipairs({ "string", "table", "math", "os", "tostring", "tonumber", "type", "pcall",
                       "ipairs", "pairs", "select", "error", "assert", "unpack", "print",
                       "setmetatable", "getmetatable", "rawget", "next", "loadstring", "require" }) do
    E[k] = _G[k]
  end
  E._G = E
  E.land = {
    -- Flat ground at 100 m; everything east of y = 5000 is water, so the
    -- surface filter in clearspot and land have something to reject.
    getHeight = function(p) return 100 end,
    getSurfaceType = function(p) if p.y and p.y > 5000 then return 3 else return 1 end end,
    isVisible = function(a, b) return b.x < 2000 end,
    getIP = function(a, dir, len) return { x = a.x + dir.x * (len / 2), y = a.y + dir.y * (len / 2), z = a.z + dir.z * (len / 2) } end,
    getClosestPointOnRoads = function(kind, x, y) return x + 25, y - 10 end,
    findPathOnRoads = function(kind, x1, y1, x2, y2) return { { x = x1, y = y1 }, { x = x2, y = y2 } } end,
  }
  E.coord = {
    LOtoLL = function(p) return 33.5 + (p.x or 0) / 100000, 42.5 + (p.z or 0) / 100000 end,
    LLtoLO = function(lat, lon, alt) return { x = lat * 1000, y = alt or 0, z = lon * 1000 } end,
  }
  E.Object = { Category = { UNIT = 1, WEAPON = 2, STATIC = 3, BASE = 4, SCENERY = 5 } }
  E.world = {
    VolumeType = { SEGMENT = 0, BOX = 1, SPHERE = 2, PYRAMID = 3 },
    getAirbases = function() return { fakeAirbase(12, "Alpha", 0, 0), fakeAirbase(13, "Bravo", 1000, 1000) } end,
    searchObjects = function(category, volume, handler)
      handler({ getPoint = function() return { x = SCENERY_AT.x, y = 100, z = SCENERY_AT.y } end,
                getTypeName = function() return "Hangar" end })
      return true
    end,
  }
  E.Airbase = { getByName = function(n) return fakeAirbase(12, n, 0, 0) end }
  E.env = { mission = { theatre = "Iraq", date = { Year = 2026, Month = 11, Day = 17 } }, info = function() end }
  E.timer = { getTime = function() return 42 end, getAbsTime = function() return 43200 end, getTime0 = function() return 0 end }
  local function fakeUnit(name)
    return {
      getName = function() return name end,
      getTypeName = function() return "M-1 Abrams" end,
      getPoint = function() return { x = 10, y = 100, z = 20 } end,
      getPosition = function() return { x = { x = 1, y = 0, z = 0 }, p = { x = 10, y = 100, z = 20 } } end,
      isActive = function() return true end,
      getLife = function() return 3 end,
      getCoalition = function() return 2 end,
    }
  end
  E.coalition = {
    side = { RED = 1, BLUE = 2, NEUTRAL = 0 },
    getGroups = function(side)
      if side ~= 2 then return {} end
      return { { getName = function() return "Armour-1" end, getUnits = function() return { fakeUnit("Armour-1-1") } end,
                 getSize = function() return 1 end, getCoalition = function() return 2 end } }
    end,
    getPlayers = function() return {} end,
  }
  E.trigger = { action = {}, misc = { getUserFlag = function() return 0 end } }
  E.Unit = { getByName = function(n) return fakeUnit(n) end }
  E.Group = { getByName = function(n) return nil end }
  return E
end

local snippetFailures = {}

net = {
  json2lua = function(s)
    -- Only the shapes the tests send; enough to exercise dispatch. The
    -- structured commands get fixed arguments per command so their snippets
    -- are actually compiled and run against the stubs above.
    local cmd = s:match('"cmd"%s*:%s*"([^"]+)"')
    if not cmd then return nil end
    local path = s:match('"path"%s*:%s*"([^"]+)"')
    local args = { path = path }
    if cmd == "airbases" then args = { from = 1, limit = 2 }
    elseif cmd == "roads" then args = { kind = "roads", points = { { x = 1000, y = 2000 } } }
    elseif cmd == "los" then args = { pairs = { { from = { x = 0, y = 0 }, to = { x = 3000, y = 0 } } } }
    elseif cmd == "clearspot" then args = { centre = { x = 0, y = 0 }, radius = 300, spacing = 100, clearance = 20 }
    elseif cmd == "land" then args = { points = { { x = 0, y = 0 }, { x = 0, y = 6000 } } }
    end
    return { cmd = cmd, args = args }
  end,
  dostring_in = function(state, code)
    -- DCS 2.9.31: only the "server" state holds the scripting globals; the
    -- hook's scripting-state resolver must find it there, not in "mission".
    if code == "return type(timer) .. ',' .. type(coalition)" then
      return state == "server" and "table,table" or "nil,nil"
    end
    if code:find("enc", 1, true) then
      -- Which state the snippet was sent to is the thing to assert on: on DCS
      -- 2.9.31 the scripting globals live in "server", and a snippet sent to
      -- "mission" lands in the trigger state where `timer` is nil.
      print("DOSTRING_STATE " .. tostring(state))
      local chunk, err = loadstring(code, "snippet")
      if not chunk then
        snippetFailures[#snippetFailures + 1] = tostring(err)
        print("SNIPPET_SYNTAX_FAIL " .. tostring(err))
        return '{"ok":false,"error":"snippet syntax"}'
      end
      setfenv(chunk, missionEnvironment())
      local okRun, out = pcall(chunk)
      if not okRun then
        snippetFailures[#snippetFailures + 1] = tostring(out)
        print("SNIPPET_RUNTIME_FAIL " .. tostring(out))
        return '{"ok":false,"error":"snippet runtime"}'
      end
      return out
    end
    return '{"ok":true,"data":{"state":"' .. state .. '"}}'
  end,
  load_mission = function(p) loadMissionCalls[#loadMissionCalls + 1] = p; return nil end,
}

local userCallbacks = nil
DCS = { setUserCallbacks = function(cb) userCallbacks = cb end }

-- The GUI updater the hook registers with so it can answer in the menus. It
-- runs on a DIFFERENT thread from the simulation, which is why mission-
-- environment commands must not be dispatched from it.
local guiCallback = nil
Gui = { AddUpdateCallback = function(fn) guiCallback = fn end }

-- --- load the hook ---------------------------------------------------------

local chunk, err = loadfile(hookPath)
assert(chunk, "hook failed to compile: " .. tostring(err))
local okRun, runErr = pcall(chunk)
assert(okRun, "hook failed to RUN: " .. tostring(runErr))
assert(userCallbacks, "hook did not register user callbacks (it aborted early)")
print("HOOK_LOADED")

-- --- drive the callbacks ---------------------------------------------------

assert(userCallbacks.onSimulationStart, "no onSimulationStart callback")
assert(userCallbacks.onSimulationFrame, "no onSimulationFrame callback")
assert(userCallbacks.onSimulationStop, "no onSimulationStop callback")

userCallbacks.onSimulationStart()
print("LISTENING")

-- A frame with no client must be harmless.
userCallbacks.onSimulationFrame()

-- Now deliver a ping and a mission query, and check the JSON that comes back.
queuedRequest = '{"cmd":"ping"}'
userCallbacks.onSimulationFrame()
queuedRequest = '{"cmd":"mission"}'
userCallbacks.onSimulationFrame()
queuedRequest = '{"cmd":"no_such_command"}'
userCallbacks.onSimulationFrame()
queuedRequest = '{"cmd":"exec"}'
userCallbacks.onSimulationFrame()
queuedRequest = '{"cmd":"status"}'
userCallbacks.onSimulationFrame()

-- --- thread routing --------------------------------------------------------
--
-- A mission-environment command must NOT be answered from the GUI tick:
-- net.dostring_in('mission', ...) called there does not reach the mission
-- scripting state, and comes back with a nil `coalition`/`timer`/`land` instead
-- of failing loudly. It has to be held until a simulation frame services it.

assert(guiCallback, "hook did not register a GUI update callback")

local before = #sent
queuedRequest = '{"cmd":"units"}'
guiCallback()
print("GUI_HELD " .. tostring(#sent == before))

userCallbacks.onSimulationFrame()
print("SIM_ANSWERED " .. tostring(#sent == before + 1))

-- `loadmission` does not touch the mission scripting environment, but
-- net.load_mission is a silent no-op unless it runs on the simulation thread, so
-- it must be held for a sim frame exactly like the mission-env commands. From a
-- cold menu (no sim frames) this is what turns a silent no-op into a clear stall.
-- (phase is "running" here, from onSimulationStart above)
before = #sent
queuedRequest = '{"cmd":"loadmission","path":"C:/m/swap.miz"}'
guiCallback()
print("GUI_LOADMISSION_HELD " .. tostring(#sent == before))

userCallbacks.onSimulationFrame()
print("SIM_LOADMISSION_ANSWERED " .. tostring(#sent == before + 1))
-- Over a running mission the swap actually reaches net.load_mission.
print("LOADMISSION_SWAPPED " .. tostring(loadMissionCalls[#loadMissionCalls] == "C:/m/swap.miz"))

-- Commands that never touch the mission environment must still answer straight
-- from the GUI tick, or the bridge goes mute in the menus and the editor.
before = #sent
queuedRequest = '{"cmd":"ping"}'
guiCallback()
print("GUI_PING_ANSWERED " .. tostring(#sent == before + 1))

userCallbacks.onSimulationStop() -- back to the menu: phase = "menu"

-- From the menu net.load_mission is a silent no-op, so loadmission must refuse
-- with a clear error instead of reporting a phantom success. Held for the sim
-- thread, then answered there against the menu phase.
local callsBefore = #loadMissionCalls
before = #sent
queuedRequest = '{"cmd":"loadmission","path":"C:/m/cold.miz"}'
guiCallback()
userCallbacks.onSimulationFrame()
local coldReply = sent[#sent] or ""
print("COLD_MENU_REFUSED " .. tostring(coldReply:find('"ok":false', 1, true) ~= nil and coldReply:find("no mission is running", 1, true) ~= nil))
print("COLD_MENU_NO_LOAD " .. tostring(#loadMissionCalls == callsBefore))

-- --- structured mission-environment commands -------------------------------
--
-- Each of these builds Lua as a string and ships it into the mission state, so
-- running them here compiles and executes those snippets against the API stubs.
-- That is the only place a typo in them is caught before someone flies.

userCallbacks.onSimulationStart() -- back to a running mission

local function callSim(request)
  local before = #sent
  queuedRequest = request
  userCallbacks.onSimulationFrame()
  if #sent == before then return nil end
  return sent[#sent]
end

local structured = {}
for _, cmd in ipairs({ "land", "airbases", "roads", "los", "clearspot" }) do
  local reply = callSim('{"cmd":"' .. cmd .. '"}') or ""
  structured[cmd] = reply
  print("STRUCTURED " .. cmd .. " " .. tostring(reply:find('"ok":true', 1, true) ~= nil))
end

-- The airbase sample must carry what an offline airbase pack needs: id, name,
-- position in map metres, lat/lon, runways and parking spots.
local ab = structured.airbases or ""
print("AIRBASES_FIELDS " .. tostring(
  ab:find('"id":12', 1, true) ~= nil and ab:find('"theatre":"Iraq"', 1, true) ~= nil and
  ab:find('"lat":', 1, true) ~= nil and ab:find('"termType":104', 1, true) ~= nil and
  ab:find('"runways"', 1, true) ~= nil))

-- Roads snap to the road graph and report how far the point moved.
print("ROADS_SNAPPED " .. tostring((structured.roads or ""):find('"roadX":1025', 1, true) ~= nil))

-- Line of sight: the stub blocks anything past x = 2000, so this pair is
-- blocked and must come back with the intersection point.
local los = structured.los or ""
print("LOS_BLOCKED " .. tostring(los:find('"visible":false', 1, true) ~= nil and los:find('"blockedAt"', 1, true) ~= nil))

-- The one stubbed scenery object sits 50 m east of the centre, so with a 20 m
-- clearance the centre node itself must survive and the node next to the
-- object must not.
local clear = structured.clearspot or ""
print("CLEARSPOT_FOUND " .. tostring(clear:find('"spots"', 1, true) ~= nil and clear:find('"sceneryObjects":1', 1, true) ~= nil))

print("SNIPPET_FAILURES " .. #snippetFailures)

for i, s in ipairs(sent) do print("REPLY " .. i .. " " .. s:gsub("%s+$", "")) end
print("DONE")
