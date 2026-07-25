-- Runs a mission's compiled triggers the way DCS does, under DCS's own Lua.
--
-- Usage: luae.exe trig-runtime.lua <mission.lua> <dictionary.lua> <scenario.lua>
--
-- The mission and dictionary are the raw entries from a `.miz`. DCS stores
-- `mission.trig.*` as Lua SOURCE STRINGS and compiles them at mission load, so
-- this harness does the same: loadstring every entry, then tick `func` each step
-- exactly as the simulation does. The scenario drives the mock world and the
-- action log is printed for the caller to assert on.

local missionFile, dictFile, scenarioFile = ...

dofile(missionFile)
dofile(dictFile)
assert(type(mission) == "table", "mission table did not load")
assert(type(mission.trig) == "table", "mission.trig missing")

-- --- mock world -------------------------------------------------------------

world = { time = 0, flags = {}, dead = {}, inZone = {}, log = {}, radio = {}, scripts = {} }

-- Log entries carry the sim time. Within one tick the order depends on how
-- `pairs` walks `mission.trig.func`, which Lua does not define, so callers group
-- by time rather than relying on that order.
local function note(s) world.log[#world.log + 1] = world.time .. " " .. s end

function getValueDictByKey(k) return dictionary[k] or "" end
function getValueResourceByKey(k) return k end

function c_time_after(s) return world.time >= s end
function c_time_since_flag(f, s)
  return world.flags[f] ~= nil and (world.time - world.flags[f]) >= s
end
function c_flag_is_true(f) return world.flags[f] ~= nil end
function c_flag_is_false(f) return world.flags[f] == nil end
function c_flag_equals(f, v) return world.flags[f] == v end
function c_flag_more(f, v) return (world.flags[f] or 0) > v end
function c_group_dead(g) return world.dead["g" .. g] == true end
function c_unit_dead(u) return world.dead["u" .. u] == true end
function c_unit_in_zone(u, z) return world.inZone["u" .. u .. ":" .. z] == true end
function c_unit_out_zone(u, z) return world.inZone["u" .. u .. ":" .. z] ~= true end
function c_group_life_less(g, p) return (world.life and world.life[g] or 100) < p end
function c_part_of_group_in_zone(g, z) return world.inZone["g" .. g .. ":" .. z] == true end
function c_part_of_coalition_in_zone(side, z, t) return world.inZone[side .. ":" .. z] == true end
function c_random_less(p) return world.random == true end

function a_out_text_delay(t, s, cv, d) note("text:" .. t) end
function a_out_text_delay_s(side, t, s, cv, d) note("text_s:" .. side .. ":" .. t) end
function a_out_text_delay_g(g, t, s, cv) note("text_g:" .. g .. ":" .. t) end
function a_set_flag(f) world.flags[f] = world.time; note("set_flag:" .. tostring(f)) end
function a_set_flag_value(f, v) world.flags[f] = v; note("set_flag_value:" .. tostring(f) .. "=" .. v) end
function a_clear_flag(f) world.flags[f] = nil; note("clear_flag:" .. tostring(f)) end
function a_activate_group(g) note("activate_group:" .. g) end
function a_deactivate_group(g) note("deactivate_group:" .. g) end
function a_group_on(g) note("group_on:" .. g) end
function a_group_off(g) note("group_off:" .. g) end
function a_group_resume(g) note("group_resume:" .. g) end
function a_explosion(z, alt, v) note("explosion:" .. z .. "@" .. v) end
function a_effect_smoke(z, p, d, n) note("smoke:" .. z .. ":" .. p) end
function a_signal_flare(z, alt, c, b) note("flare:" .. z .. ":" .. c) end
function a_end_mission(w, t, d) note("end_mission:" .. w .. "+" .. d) end
function a_set_flag_random(f, lo, hi) world.flags[f] = lo; note("set_flag_random:" .. tostring(f)) end
function a_out_text_delay_u(u, t, s, cv, d) note("text_u:" .. u .. ":" .. t) end
function a_out_text_delay_c(c, t, s, cv, d) note("text_c:" .. c .. ":" .. t) end
function a_out_sound(r, d) note("sound:" .. r) end
function a_out_sound_s(side, r, d) note("sound_s:" .. side .. ":" .. r) end
function a_out_sound_g(g, r, d) note("sound_g:" .. g .. ":" .. r) end
function a_out_sound_stop() note("sound_stop") end
function a_radio_transmission(r, z, mod, loop, hz, pw, name, d, mic, sq)
  note("radio:" .. name .. ":" .. hz .. ":" .. r)
end
function a_do_script(src) note("do_script"); world.scripts[#world.scripts + 1] = "inline" end
function a_do_script_file(r) note("do_script_file:" .. r); world.scripts[#world.scripts + 1] = r end
function c_start_wait_for_user(f, fb) note("wait_for_user:" .. tostring(f)) end
function c_stop_wait_for_user() note("stop_wait_for_user") end

-- Radio menu (F10 "Other"). Picking an item is what raises its flag in DCS, so
-- the mock records the mapping and `pickRadioItem` performs the click.
function a_add_radio_item(text, flag, value)
  world.radio[text] = { flag = flag, value = value }
  note("radio_item+:" .. text)
end
function a_add_radio_item_for_group(g, text, flag, value)
  world.radio[text] = { flag = flag, value = value, group = g }
  note("radio_item_g+:" .. g .. ":" .. text)
end
function a_remove_radio_item(text) world.radio[text] = nil; note("radio_item-:" .. text) end
function a_remove_radio_item_for_group(g, text)
  world.radio[text] = nil; note("radio_item_g-:" .. g .. ":" .. text)
end

function pickRadioItem(text)
  local item = world.radio[text]
  assert(item, "no radio item named '" .. tostring(text) .. "'")
  world.flags[item.flag] = item.value
  note("PICK:" .. text)
end

-- --- compile exactly as DCS does -------------------------------------------

local function compileAll(tbl, label)
  local n = 0
  for i, src in pairs(tbl) do
    local fn, err = loadstring(src, label .. "[" .. i .. "]")
    if not fn then
      error(label .. "[" .. i .. "] failed to compile: " .. tostring(err) .. "\n  " .. src)
    end
    tbl[i] = fn
    n = n + 1
  end
  return n
end

compileAll(mission.trig.conditions, "conditions")
compileAll(mission.trig.actions, "actions")
compileAll(mission.trig.func, "func")
compileAll(mission.trig.funcStartup, "funcStartup")

function runStartup()
  for i, f in pairs(mission.trig.funcStartup) do f() end
end

-- A triggerOnce clears its own `mission.trig.func` slot from inside its action,
-- so the tick loop must tolerate the table shrinking underneath it.
function tick(t)
  if t then world.time = t end
  for i, f in pairs(mission.trig.func) do f() end
end

dofile(scenarioFile)

for i, s in ipairs(world.log) do print("LOG " .. i .. " " .. s) end
for i, s in ipairs(world.scripts) do print("SCRIPT " .. i .. " " .. s) end
print("DONE")
