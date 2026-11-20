-- Trusted generated fixtures only. Stock Lua 5.1 + mocked DCS APIs; NOT a DCS run.
assert(_VERSION == 'Lua 5.1')
local missionPath, dictionaryPath, manifestPath, mode, order = arg[1], arg[2], arg[3], arg[4], arg[5]
dofile(missionPath); dofile(dictionaryPath); dofile(manifestPath)
local now, values, changed, deadGroups, deadUnits, handlers, scheduled, scores = 0, {}, {}, {}, {}, {}, {}, {}
local function setFlag(flag, value)
  flag = tonumber(flag); if (values[flag] or 0) ~= value then changed[flag] = now end; values[flag] = value
end
trigger = { misc = { getUserFlag = function(flag) return values[tonumber(flag)] or 0 end }, action = { setUserFlag = setFlag } }
timer = { getTime = function() return now end, scheduleFunction = function(fn, args, at) scheduled[#scheduled + 1] = { fn = fn, args = args, at = at } end }
world = { event = { S_EVENT_TAKEOFF = 3 }, addEventHandler = function(h) handlers[#handlers + 1] = h end }
env = { error = function(s) error(s) end }
function getValueDictByKey(key) return dictionary[key] or key end
function c_time_after(seconds) return now >= seconds end
function c_time_since_flag(flag, seconds) return changed[flag] ~= nil and now - changed[flag] >= seconds end
function c_flag_equals(flag, value) return (values[flag] or 0) == value end
function c_flag_is_true(flag) return (values[flag] or 0) ~= 0 end
function c_flag_is_false(flag) return (values[flag] or 0) == 0 end
function c_group_dead(id) return deadGroups[id] == true end
function c_unit_dead(id) return deadUnits[id] == true end
function a_set_flag(flag) setFlag(flag, 1) end
function a_set_flag_value(flag, value) setFlag(flag, value) end
function a_out_text_delay_s() end
function a_do_script(source) assert(loadstring(source))() end
function a_set_mission_result(score) scores[#scores + 1] = score end
for _, section in ipairs({ 'conditions', 'actions', 'func', 'funcStartup' }) do
  for i, source in pairs(mission.trig[section] or {}) do mission.trig[section][i] = assert(loadstring(source)) end
end
for _, side in ipairs({ 'blue', 'red', 'offline' }) do
  for _, section in ipairs({ 'conditions', 'actions', 'func' }) do
    for i, source in pairs((mission.result[side] or {})[section] or {}) do mission.result[side][section][i] = assert(loadstring(source)) end
  end
end
local function tick(time)
  now = time
  local keys = {}; for i in pairs(mission.trig.func) do keys[#keys + 1] = i end
  table.sort(keys, function(a, b) if order == 'reverse' then return a > b else return a < b end end)
  for _, i in ipairs(keys) do if mission.trig.func[i] then mission.trig.func[i]() end end
  local ready = scheduled; scheduled = {}
  for _, task in ipairs(ready) do
    if task.at <= now then local nextTime = task.fn(task.args, task.at); if nextTime then timer.scheduleFunction(task.fn, task.args, nextTime) end
    else scheduled[#scheduled + 1] = task end
  end
end
for _, fn in pairs(mission.trig.funcStartup) do fn() end
assert(#handlers == 1, 'Director world handler missing')
handlers[1]:onEvent({ id = world.event.S_EVENT_TAKEOFF, initiator = { getName = function() return 'Wrong aircraft' end } })
tick(0); assert((values[manifest.departure] or 0) == 0, 'Wrong unit triggered departure')
handlers[1]:onEvent({ id = world.event.S_EVENT_TAKEOFF, initiator = { getName = function() return 'Intercept-1' end } })
tick(0); assert(values[manifest.departure] == 1, 'Real takeoff did not trigger departure')
tick(9); assert((values[manifest.update] or 0) == 0, 'Event-relative delay fired early')
tick(10); assert(values[manifest.update] == 1, 'Event-relative tactical update did not fire')
deadGroups[manifest.enemyGroup] = true
if mode == 'failure' then deadUnits[manifest.playerUnit] = true end
tick(20); assert((values[manifest.outcome] or 0) == 0, 'Outcome resolved before the arbitration window')
tick(21); tick(22)
assert(values[manifest.outcome] == (mode == 'failure' and 2 or 1), 'Outcome depends on trigger ordering')
for _, fn in pairs(mission.result.blue.func) do fn() end
assert(#scores == 1 and scores[1] == (mode == 'failure' and 0 or 100), 'Compiled score/result did not follow outcome')
setFlag(7001, 1); tick(23); assert(values[7000] == 2, 'Counter did not increment')
tick(24); assert(values[7000] == 2, 'Change counter repeated while condition stayed true')
setFlag(7001, 0); tick(25); setFlag(7001, 1); tick(26); assert(values[7000] == 4, 'Change counter did not rearm')
print('LUA51_DESIGN_OK ' .. mode .. ' ' .. order .. ' events, delays, outcome, score, counter; NOT DCS verified')
