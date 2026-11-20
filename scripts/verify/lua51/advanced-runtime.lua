-- Generic Lua 5.1 regression harness with mocked DCS/Skynet, NOT a DCS run.
assert(_VERSION == 'Lua 5.1', 'Use a Lua 5.1 interpreter')
local setupPath, telemetryPath = arg[1], arg[2]
local logs, scheduled = {}, {}
env = { mission = { theatre = 'Caucasus' }, info = function(s) logs[#logs + 1] = s end,
  error = function(s) error('Unexpected telemetry error: ' .. tostring(s)) end }
timer = { getTime = function() return 0 end, scheduleFunction = function(fn, args, at)
  scheduled[#scheduled + 1] = { fn = fn, args = args, at = at }
end }
world = { event = {}, addEventHandler = function(h) assert(type(h.onEvent) == 'function') end }
coalition = { side = { RED = 1, BLUE = 2, NEUTRAL = 0 }, getGroups = function() return {} end }
Group = { Category = { GROUND = 2, AIRPLANE = 0 } }
mist = { majorVersion = 4, minorVersion = 5, build = 1 }
BASE, _DATABASE = {}, {}
local sites = { { range = 0, harm = 0 } }
local site = sites[1]
function site:setGoLiveRangeInPercent(v) self.range = v end
function site:setHARMDetectionChance(v) self.harm = v end
function site:isDestroyed() return false end
function site:hasWorkingPowerSource() return true end
function site:hasActiveConnectionNode() return true end
function site:isActive() return true end
function site:getDCSName() return 'SAM-Test' end
function site:getNatoName() return 'SA-6' end
function site:hasWorkingRadar() return true end
function site:hasRemainingAmmo() return true end
function site:isDefendingHARM() return false end
function site:getAutonomousState() return false end
-- The proxy's own non-array field must never be sampled as a site.
sites.__index = function() error('Do not iterate Skynet proxy with pairs') end
local network = {}
SkynetIADS = { VERSION = 'mock', create = function(_, name) network.name = name; return network end }
function network:addEarlyWarningRadarsByPrefix(prefix) self.ewr = prefix end
function network:addSAMSitesByPrefix(prefix) self.sam = prefix end
function network:getSAMSites() return sites end
function network:getEarlyWarningRadars() return { { name = 'EW-Test-1' } } end
function network:activate() self.active = true end
function network:addRadioMenu() self.menu = true end
assert(loadfile(setupPath))()
assert(network.active and network.menu)
assert(network.sam == 'SAM' and network.ewr == 'EW')
assert(site.range == 70 and site.harm == 90)
assert(DCSMCP_IADS['Runtime Test'] == network, 'Network not registered for telemetry')
-- A second legacy alias must not cause duplicate samples.
redIADS = network
assert(loadfile(telemetryPath))()
for _, schedule in ipairs(scheduled) do schedule.fn(schedule.args, schedule.at) end
local siteCount, networkCount = 0, 0
for _, line in ipairs(logs) do
  if line:find(' IADS_SITE ', 1, true) then siteCount = siteCount + 1 end
  if line:find(' IADS ', 1, true) and line:find('samLive=1', 1, true) then networkCount = networkCount + 1 end
end
assert(siteCount == 1 and networkCount == 1, 'Legacy/registry network sampled twice or missing')
print('LUA51_ADVANCED_OK mocked setup, proxy iteration, telemetry, and deduplication; NOT DCS verified')
