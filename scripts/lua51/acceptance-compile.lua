-- Only trusted generated data fixtures; no untrusted .miz Lua is executed.
assert(_VERSION == 'Lua 5.1')
assert(loadfile(arg[1]))()
for _, section in ipairs({'conditions', 'actions', 'func', 'funcStartup'}) do
 for _, code in pairs(mission.trig[section] or {}) do assert(loadstring(code)) end
end
for _, side in ipairs({'blue', 'red', 'offline'}) do
 for _, section in ipairs({'conditions', 'actions', 'func'}) do
  for _, code in pairs((mission.result[side] or {})[section] or {}) do assert(loadstring(code)) end
 end
end
print('LUA51_COMPILE_OK (no DCS APIs executed)')
