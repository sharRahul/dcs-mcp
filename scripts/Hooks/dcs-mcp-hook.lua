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

local socket = require("socket")
local server = nil

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
    local sides = { red = coalition.side.RED, blue = coalition.side.BLUE, neutral = coalition.side.NEUTRAL }
    local out, count = {}, 0
    local function collect(sideName, sideId)
      for _, grp in ipairs(coalition.getGroups(sideId) or {}) do
        for _, u in ipairs(grp:getUnits() or {}) do
          if count >= %d then break end
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
      if want == "all" or want == name then collect(name, id) end
    end
    return '{"ok":true,"data":' .. enc({ count = count, units = out }) .. '}'
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
local function poll()
  if not server then return end
  local client = server:accept()
  if not client then return end
  client:settimeout(0.1)
  local line = client:receive("*l")
  if line then
    local response
    local okr, res = pcall(dispatch, line)
    response = okr and res or fail(res)
    client:send(response .. "\n")
  end
  client:close()
end

local callbacks = {}

function callbacks.onSimulationStart()
  if server then return end
  server = socket.tcp()
  if server then
    server:setoption("reuseaddr", true)
    server:bind(HOST, PORT)
    server:listen(8)
    server:settimeout(0)
    log.write("DCS-MCP", log.INFO, "hook server listening on " .. HOST .. ":" .. PORT)
  end
end

function callbacks.onSimulationFrame()
  local okp, err = pcall(poll)
  if not okp then log.write("DCS-MCP", log.ERROR, "poll error: " .. tostring(err)) end
end

function callbacks.onSimulationStop()
  if server then server:close(); server = nil end
end

DCS.setUserCallbacks(callbacks)
