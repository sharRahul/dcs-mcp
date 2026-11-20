-- Loads runtime/dcs/dcs-mcp-telemetry.lua under DCS's Lua 5.1 with the mission
-- environment stubbed, and prints every log line it writes as
-- "<LEVEL> <message>", so the framework audit's severities can be asserted.
-- Usage: luae.exe telemetry-frameworks.lua <telemetry.lua> <case>
--   case "mist-missing": the mission loads mist_4_5_126.lua, MIST is absent
--   case "unknown":      no getValueResourceByKey, expectation cannot be read
--   case "partial":      expectation unreadable, MIST present, MOOSE/Skynet missing
local script, case = arg[1], arg[2]

env = {
  info = function(m) print("INFO " .. m) end,
  error = function(m) print("ERROR " .. m) end,
  warning = function(m) print("WARNING " .. m) end,
  mission = {
    theatre = "Caucasus",
    trigrules = {
      [1] = {
        predicate = "triggerStart",
        comment = "Load Scripts",
        actions = {
          [1] = { predicate = "a_do_script_file", file = "ResKey_Action_1" },
          [2] = { predicate = "a_do_script_file", file = "ResKey_Action_2" },
        },
      },
    },
  },
}
local resources = {
  ResKey_Action_1 = "C:\\Users\\x\\AppData\\Local\\Temp\\DCS\\Mission\\l10n\\DEFAULT\\mist_4_5_126.lua",
  ResKey_Action_2 = "C:\\Users\\x\\AppData\\Local\\Temp\\DCS\\Mission\\l10n\\DEFAULT\\dcs-mcp-telemetry.lua",
}
if case == "partial" then mist = { majorVersion = 4, minorVersion = 5, build = 126 } end
if case ~= "unknown" and case ~= "partial" then
  function getValueResourceByKey(key) return resources[key] end
end
timer = { getTime = function() return 0 end, scheduleFunction = function() end }
world = { addEventHandler = function() end, event = { S_EVENT_SHOT = 1, S_EVENT_DEAD = 8 } }

dofile(script)
