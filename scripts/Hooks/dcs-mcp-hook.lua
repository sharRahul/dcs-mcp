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

local server = nil
local pending = {}              -- in-flight clients: { sock, buffer, deadline }

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

local enc = assert(load(JSON_ENC_SRC .. "\nreturn enc"))()

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
----------------------------------------------------------------------
local function dispatch(line)
  local req
  if net and net.json2lua then
    local okd, parsed = pcall(net.json2lua, line)
    if okd then req = parsed end
  end
  if type(req) ~= "table" or not req.cmd then
    return fail("Malformed request; expected JSON {\"cmd\":...}")
  end
  local handler = handlers[req.cmd]
  if not handler then return fail("Unknown command: " .. tostring(req.cmd)) end
  local okc, res = pcall(handler, req.args)
  if okc then return res end
  return fail(res)
end

----------------------------------------------------------------------
-- Non-blocking TCP server driven by the simulation frame callback
----------------------------------------------------------------------
local function respond(entry, line)
  local okr, res = pcall(dispatch, line)
  entry.sock:send((okr and res or fail(res)) .. "\n")
end

--[[
  Service in-flight clients without blocking the simulation.

  Every socket here is non-blocking. A request that has not arrived in full is
  kept in `pending` and retried on the next frame rather than blocking on
  receive: a blocking read stalls the whole DCS frame, which shows up as a
  visible stutter whenever a client connects slowly or dies mid-request.
--]]
local function service()
  local now = os.clock()
  local keep = {}
  for _, entry in ipairs(pending) do
    local done = false
    local line, err, partial = entry.sock:receive("*l")
    if line then
      entry.buffer = entry.buffer .. line
      local okr, e = pcall(respond, entry, entry.buffer)
      if not okr then log.write("DCS-MCP", log.ERROR, "response failed: " .. tostring(e)) end
      done = true
    elseif err == "timeout" then
      entry.buffer = entry.buffer .. (partial or "")
      if now >= entry.deadline then
        pcall(function() entry.sock:send(fail("request timed out before a full line arrived") .. "\n") end)
        done = true
      end
    else
      done = true -- "closed" or a hard error: nothing more is coming
    end

    if done then
      pcall(function() entry.sock:close() end)
    else
      keep[#keep + 1] = entry
    end
  end
  pending = keep
end

local function poll()
  if not server then return end
  for _ = 1, MAX_ACCEPTS_PER_FRAME do
    local client = server:accept()
    if not client then break end
    client:settimeout(0) -- never block the simulation frame
    pending[#pending + 1] = { sock = client, buffer = "", deadline = os.clock() + REQUEST_TIMEOUT_S }
  end
  service()
end

local callbacks = {}

function callbacks.onSimulationStart()
  if server then return end
  local sock, err = socket.tcp()
  if not sock then
    log.write("DCS-MCP", log.ERROR, "socket.tcp() failed: " .. tostring(err))
    return
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
    return
  end
  local okListen, listenErr = sock:listen(8)
  if not okListen then
    log.write("DCS-MCP", log.ERROR, "listen failed: " .. tostring(listenErr))
    sock:close()
    return
  end
  sock:settimeout(0)
  server = sock
  log.write("DCS-MCP", log.INFO, "hook server listening on " .. HOST .. ":" .. PORT)
end

function callbacks.onSimulationFrame()
  local okp, err = pcall(poll)
  if not okp then log.write("DCS-MCP", log.ERROR, "poll error: " .. tostring(err)) end
end

function callbacks.onSimulationStop()
  for _, entry in ipairs(pending) do pcall(function() entry.sock:close() end) end
  pending = {}
  if server then server:close(); server = nil end
end

DCS.setUserCallbacks(callbacks)
