-- Reproduces the DCS Mission Editor's load-time fixups against a mission table,
-- so a mission the editor cannot open fails here instead of in the GUI.
--
-- `fixUnitsPos` is transcribed from
-- `<DCS>/MissionEditor/modules/me_mission.lua`. It indexes `route.points[1]`
-- for EVERY group that has a route, which is why a group with an empty `points`
-- table makes the editor abort loading the whole mission with
-- "attempt to index field '?' (a nil value)".

local missionFile = ...
dofile(missionFile)
assert(type(mission) == "table", "mission table did not load")

-- Build the editor's unit index: every unit, with `boss` pointing at its group.
local unit_by_id = {}
local groups = 0
for _, sideName in ipairs({ "red", "blue", "neutrals" }) do
  local side = mission.coalition and mission.coalition[sideName]
  if side and side.country then
    for _, country in pairs(side.country) do
      for _, category in ipairs({ "plane", "helicopter", "vehicle", "ship", "static" }) do
        local cat = country[category]
        if cat and cat.group then
          for _, group in pairs(cat.group) do
            groups = groups + 1
            group.type = category
            for _, unit in pairs(group.units or {}) do
              unit.boss = group
              unit_by_id[#unit_by_id + 1] = unit
            end
          end
        end
      end
    end
  end
end

-- Verbatim from me_mission.lua, minus the MapWindow call (GUI-only).
local function fixUnitsPos()
  for _tmp, v in pairs(unit_by_id) do
    if v.boss then
      if v.boss.route
        and (not (v.boss.route.points[1].action == 'From Ground Area'
           or v.boss.route.points[1].action == 'From Ground Area Hot'
           or v.boss.route.points[1].action == 'On Road')) then
        local p1 = v.boss.route.points[1]
        if p1 then
          v.speed = p1.speed
          v.alt = p1.alt
          v.alt_type = p1.alt_type
          local p2 = v.boss.route.points[2]
          if p2 and v.boss.manualHeading ~= true then
            v.heading = math.atan2(p2.y - p1.y, p2.x - p1.x)
          end
        end
      end
    end
  end
end

local ok, err = pcall(fixUnitsPos)
if not ok then
  print("ME_LOAD_FAILED " .. tostring(err))
  os.exit(1)
end

print("GROUPS " .. groups)
print("UNITS " .. #unit_by_id)
print("ME_LOAD_OK")
