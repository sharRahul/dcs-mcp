--[[
  dcs-mcp-server TELEMETRY-ONLY bridge (lightweight, no de-sanitizing required).

  Install into:  Saved Games/DCS/Scripts/Export.lua   (chains any existing hooks)

  Use this if you only want read-only ownship telemetry and do NOT want to install
  the Hooks server. It answers the read-only commands available in the Export
  environment: ping, self, mission. For live control (units, spawn, message,
  coordinate conversion, exec) install scripts/Hooks/dcs-mcp-hook.lua instead.

  Same wire protocol as the hook (newline-terminated JSON, one round trip):
    -> {"cmd":"self"}      <- {"ok":true,"data":{...}}

  Reference: DCS Lua Export -- https://www.digitalcombatsimulator.com/en/dev_journal/lua-export/
             sprhawk/dcs_scripts (socket bridge pattern)
--]]

local HOST = "127.0.0.1"
local PORT = 8898   -- distinct from the Hooks server (8899) so both can coexist

local _prevStart = LuaExportStart
local _prevAfter = LuaExportAfterNextFrame
local _prevStop  = LuaExportStop

local socket = require("socket")
local server = nil

local function enc(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.9g", v)
  end
  if t == "boolean" then return v and "true" or "false" end
  if t == "string" then
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
      local m = {['"']='\\"',['\\']='\\\\',['\n']='\\n',['\r']='\\r',['\t']='\\t'}
      return m[c] or string.format("\\u%04x", string.byte(c))
    end) .. '"'
  end
  if t == "table" then
    local parts = {}
    for k, val in pairs(v) do parts[#parts+1] = '"' .. tostring(k) .. '":' .. enc(val) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local function safe(fn) local ok, r = pcall(fn); if ok then return r end end

local function handle(cmd)
  if cmd == "ping" then
    return { pong = true, time = safe(LoGetModelTime) }
  elseif cmd == "self" then
    local d = safe(LoGetSelfData) or {}
    local pby = safe(LoGetADIPitchBankYaw) or {}
    return {
      name = d.Name, position = d.LatLongAlt,
      altBar = safe(LoGetAltitudeAboveSeaLevel), altRad = safe(LoGetAltitudeAboveGroundLevel),
      pitch = pby[1], bank = pby[2], yaw = pby[3],
      ias = safe(LoGetIndicatedAirSpeed), tas = safe(LoGetTrueAirSpeed), mach = safe(LoGetMachNumber),
    }
  elseif cmd == "mission" then
    local d = safe(LoGetSelfData) or {}
    return { modelTime = safe(LoGetModelTime), startTime = safe(LoGetMissionStartTime), selfName = d.Name }
  end
  return nil, "unknown or unsupported command in export env: " .. tostring(cmd)
end

local function respond(line)
  local cmd = line:match('"cmd"%s*:%s*"([%w_]+)"') or line:gsub("%s+$", "")
  local data, err = handle(cmd)
  if data ~= nil then return '{"ok":true,"data":' .. enc(data) .. '}' end
  return '{"ok":false,"error":' .. enc(err or "error") .. '}'
end

function LuaExportStart()
  if _prevStart then pcall(_prevStart) end
  server = socket.tcp()
  if server then
    server:setoption("reuseaddr", true)
    server:bind(HOST, PORT)
    server:listen(4)
    server:settimeout(0)
  end
end

function LuaExportAfterNextFrame()
  if _prevAfter then pcall(_prevAfter) end
  if not server then return end
  local client = server:accept()
  if client then
    client:settimeout(0.05)
    local line = client:receive("*l")
    if line then client:send(respond(line) .. "\n") end
    client:close()
  end
end

function LuaExportStop()
  if server then server:close(); server = nil end
  if _prevStop then pcall(_prevStop) end
end
