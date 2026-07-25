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
    for k, val in pairs(v) do parts[#parts+1] = '"' .. tostring(k) .. '":' .. enc(val) end
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
local function runIn(state, body)
  local snippet = JSON_ENC_SRC .. "\n" ..
    "local ok_, res_ = pcall(function()\n" .. body .. "\nend)\n" ..
    "if ok_ then return res_ else return '{\"ok\":false,\"error\":' .. enc(tostring(res_)) .. '}' end"
  local out = net.dostring_in(state, snippet)
  if type(out) ~= "string" or out == "" then
    return fail("net.dostring_in('" .. state .. "') returned no data (is a mission running?)")
  end
  return out
end

----------------------------------------------------------------------
-- Command handlers. Structured ones return an envelope STRING.
----------------------------------------------------------------------
local handlers = {}

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
    local pby = LoGetADIPitchBankYaw() or {}
    return '{"ok":true,"data":' .. enc({
      name = d.Name, position = d.LatLongAlt,
      altBar = LoGetAltitudeAboveSeaLevel(), altRad = LoGetAltitudeAboveGroundLevel(),
      pitch = pby[1], bank = pby[2], yaw = pby[3],
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
                          alt = p.y, heading = u:getHeading() }
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
      route = { points = {} },
      units = { { name = name .. "-1", type = unitType, x = vec.x, y = vec.z,
                  heading = heading, skill = "Average", playerCanDrive = false } },
    }
    coalition.addGroup(countryId, Group.Category.GROUND, group)
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
  spawn = true, ll2xz = true, xz2ll = true, land = true, exec = true,
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
  entry.sock:send((okr and res or fail(res)) .. "\n")
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

    if entry.req then
      -- Already read, and held back for the simulation thread. DCS runs Lua 5.1
      -- here, so there is no `goto`/`continue` to skip the read path with.
      if source == "sim" then
        local okr, e = pcall(respond, entry, entry.req)
        if not okr then recordError("response failed", e) end
        done = true
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
        local req = parseRequest(entry.buffer)
        if not req then
          pcall(function() entry.sock:send(fail("Malformed request; expected JSON {\"cmd\":...}") .. "\n") end)
          done = true
        elseif needsSimThread(req) and source ~= "sim" then
          -- Hold it for the simulation tick instead of answering from the GUI
          -- thread, where the mission environment is not visible.
          entry.req = req
        else
          local okr, e = pcall(respond, entry, req)
          if not okr then recordError("response failed", e) end
          done = true
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
    pending[#pending + 1] = { sock = client, buffer = "", deadline = os.clock() + REQUEST_TIMEOUT_S }
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

local function guiTick()
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

local callbacks = {}

function callbacks.onSimulationStart()
  missionState.phase = "running"
  startServer() -- no-op when the load-time start already succeeded
end

function callbacks.onSimulationFrame()
  lastSimFrame = os.clock()
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

DCS.setUserCallbacks(callbacks)

startServer()
registerGuiTick()
