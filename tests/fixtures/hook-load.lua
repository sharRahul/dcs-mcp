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
  send = function(_, s) sent[#sent + 1] = s end,
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

net = {
  json2lua = function(s)
    -- Only the shapes the tests send; enough to exercise dispatch.
    local cmd = s:match('"cmd"%s*:%s*"([^"]+)"')
    if not cmd then return nil end
    return { cmd = cmd, args = {} }
  end,
  dostring_in = function(state, code) return '{"ok":true,"data":{"state":"' .. state .. '"}}' end,
}

local userCallbacks = nil
DCS = { setUserCallbacks = function(cb) userCallbacks = cb end }

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

userCallbacks.onSimulationStop()

for i, s in ipairs(sent) do print("REPLY " .. i .. " " .. s:gsub("%s+$", "")) end
print("DONE")
