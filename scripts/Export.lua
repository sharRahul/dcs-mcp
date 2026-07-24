--[[
  dcs-mcp-server live telemetry bridge.

  Install into:  Saved Games/DCS/Scripts/Export.lua   (chains any existing hooks)
  Then enable the export by allowing LuaSocket in DCS (default in recent versions).

  Opens a local, non-blocking TCP listener. On each connection it reads one command
  line and replies with a single line of JSON. Read-only: only the whitelisted
  commands below are answered; no arbitrary Lua is ever accepted or run.

  Protocol (newline-terminated):
    -> ping      <- {"pong":true,"time":<modelTime>}
    -> self      <- {"name":..,"altBar":..,"altRad":..,"pitch":..,"bank":..,"yaw":..,"ias":..,"tas":..,"mach":..,"position":{...}}
    -> mission   <- {"modelTime":..,"startTime":..,"selfName":..}

  Reference: DCS Lua export -- https://www.digitalcombatsimulator.com/en/dev_journal/lua-export/
             sprhawk/dcs_scripts (socket bridge pattern)
--]]

local DCS_MCP_HOST = "127.0.0.1"
local DCS_MCP_PORT = 8899

-- Preserve any hooks defined by other export scripts so we chain, not clobber.
local _prevStart  = LuaExportStart
local _prevAfter  = LuaExportAfterNextFrame
local _prevStop   = LuaExportStop

local socket = require("socket")
local server = nil

-- Minimal JSON encoder for numbers, strings, booleans, nil, arrays and maps.
local function jsonEncode(value)
  local t = type(value)
  if t == "number" then
    if value ~= value or value == math.huge or value == -math.huge then return "null" end
    return string.format("%.6g", value)
  elseif t == "boolean" then
    return value and "true" or "false"
  elseif t == "string" then
    return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
      local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
      return map[c] or string.format("\\u%04x", string.byte(c))
    end) .. '"'
  elseif t == "table" then
    -- Array if keys are 1..n contiguous.
    local n, isArray = 0, true
    for k in pairs(value) do
      n = n + 1
      if type(k) ~= "number" then isArray = false end
    end
    local parts = {}
    if isArray and n > 0 then
      for i = 1, n do parts[#parts + 1] = jsonEncode(value[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, v in pairs(value) do
      parts[#parts + 1] = '"' .. tostring(k) .. '":' .. jsonEncode(v)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local function safe(fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  return nil
end

local function buildSelf()
  local pby = safe(LoGetADIPitchBankYaw) or {}
  local self = safe(LoGetSelfData) or {}
  return {
    name    = self.Name,
    altBar  = safe(LoGetAltitudeAboveSeaLevel),
    altRad  = safe(LoGetAltitudeAboveGroundLevel),
    pitch   = pby[1],
    bank    = pby[2],
    yaw     = pby[3],
    ias     = safe(LoGetIndicatedAirSpeed),
    tas     = safe(LoGetTrueAirSpeed),
    mach    = safe(LoGetMachNumber),
    position = self.LatLongAlt,
  }
end

local function buildMission()
  local self = safe(LoGetSelfData) or {}
  return {
    modelTime = safe(LoGetModelTime),
    startTime = safe(LoGetMissionStartTime),
    selfName  = self.Name,
  }
end

local function handle(command)
  if command == "ping" then
    return { pong = true, time = safe(LoGetModelTime) }
  elseif command == "self" then
    return buildSelf()
  elseif command == "mission" then
    return buildMission()
  end
  return { error = "unknown command", command = command }
end

function LuaExportStart()
  if _prevStart then pcall(_prevStart) end
  server = socket.tcp()
  if server then
    server:setoption("reuseaddr", true)
    server:bind(DCS_MCP_HOST, DCS_MCP_PORT)
    server:listen(4)
    server:settimeout(0) -- non-blocking accept
  end
end

function LuaExportAfterNextFrame()
  if _prevAfter then pcall(_prevAfter) end
  if not server then return end
  local client = server:accept()
  if client then
    client:settimeout(0.05)
    local line = client:receive("*l")
    if line then
      local response = handle((line:gsub("%s+$", "")))
      client:send(jsonEncode(response) .. "\n")
    end
    client:close()
  end
end

function LuaExportStop()
  if server then server:close(); server = nil end
  if _prevStop then pcall(_prevStop) end
end
