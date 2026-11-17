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
net = {
  json2lua = function(s)
    -- Only the shapes the tests send; enough to exercise dispatch.
    local cmd = s:match('"cmd"%s*:%s*"([^"]+)"')
    if not cmd then return nil end
    local path = s:match('"path"%s*:%s*"([^"]+)"')
    return { cmd = cmd, args = { path = path } }
  end,
  dostring_in = function(state, code)
    -- DCS 2.9.31: only the "server" state holds the scripting globals; the
    -- hook's scripting-state resolver must find it there, not in "mission".
    if code == "return type(timer) .. ',' .. type(coalition)" then
      return state == "server" and "table,table" or "nil,nil"
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

for i, s in ipairs(sent) do print("REPLY " .. i .. " " .. s:gsub("%s+$", "")) end
print("DONE")
