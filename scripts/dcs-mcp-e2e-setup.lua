--[[
  Setup script for the DCS-MCP end-to-end test mission.

  Loaded by the "Load Scripts" MISSION START trigger AFTER MIST, MOOSE and
  Skynet-IADS (see src/miz/frameworks.ts for why that ordering has to come from
  one trigger). Its job is twofold:

    1. Build the red IADS out of the mission's SAM/EW groups.
    2. Actually *use* each framework, not merely load it.

  The second point is the whole reason this file exists. A framework that is
  embedded and executed still reports "loaded" if its initialisation half-failed;
  the only honest check is to call into it and log the answer. Each proof is
  independently pcall'd so one framework breaking does not hide the other two.
]]

local function say(kind, msg)
  if DCSMCP and DCSMCP.log then
    DCSMCP.log(kind, msg)
  else
    env.info("[DCSMCP] " .. kind .. " " .. tostring(msg))
  end
end

local function proof(name, fn)
  local ok, result = pcall(fn)
  if ok then
    say("PROOF", string.format("framework=%s ok=1 detail=%s", name, tostring(result):gsub("%s+", "_")))
  else
    env.error(string.format("[DCSMCP] PROOF framework=%s ok=0 error=%s", name, tostring(result)))
  end
end

---------------------------------------------------------------------------
-- MIST
---------------------------------------------------------------------------

proof("MIST", function()
  -- mist.DBs.MEgroupsByName is built during MIST's own init, so a non-empty
  -- table proves MIST ran rather than just being present as a global.
  local count = 0
  for _ in pairs(mist.DBs.MEgroupsByName or {}) do count = count + 1 end
  -- zoneToVec3 returns an EMPTY table for a zone it cannot find, not nil, so the
  -- check has to be on a coordinate rather than on the table itself.
  local zone = mist.utils.zoneToVec3("IngressZone")
  return string.format("meGroups=%d version=%s.%s zoneResolved=%s",
    count, tostring(mist.majorVersion), tostring(mist.minorVersion), tostring(zone.x ~= nil))
end)

---------------------------------------------------------------------------
-- MOOSE
---------------------------------------------------------------------------

proof("MOOSE", function()
  -- _DATABASE is populated by MOOSE's own start-up sweep of the mission, so
  -- finding our groups in it proves MOOSE indexed this mission.
  local groups = 0
  for _ in pairs(_DATABASE.GROUPS or {}) do groups = groups + 1 end

  -- A real MOOSE object, and a real MOOSE scheduler tick, logged once.
  local convoy = GROUP:FindByName("Convoy-Redline")
  SCHEDULER:New(nil, function()
    say("MOOSE_TICK", string.format("t=%s convoyAlive=%s",
      string.format("%.0f", timer.getTime()),
      tostring(convoy ~= nil and convoy:IsAlive() == true)))
  end, {}, 60, 120)

  return string.format("dbGroups=%d convoyFound=%s", groups, tostring(convoy ~= nil))
end)

---------------------------------------------------------------------------
-- Skynet-IADS
---------------------------------------------------------------------------

proof("SKYNET", function()
  redIADS = SkynetIADS:create('REDLINE')

  local dbg = redIADS:getDebugSettings()
  dbg.IADSStatus = true
  dbg.radarWentDark = true
  dbg.radarWentLive = true
  dbg.contacts = true
  dbg.harmDefence = true
  dbg.samSiteStatusEnvOutput = true
  dbg.earlyWarningRadarStatusEnvOutput = true

  -- Prefix matching is Skynet's contract: EW matches UNIT names, SAM matches
  -- GROUP names. The mission is authored to those prefixes on purpose.
  redIADS:addEarlyWarningRadarsByPrefix('EW')
  redIADS:addSAMSitesByPrefix('SAM')

  -- The SA-6 always reacts to a HARM, so the HARM-defence path is exercised
  -- rather than left to chance during a single test flight.
  local sa6 = redIADS:getSAMSiteByGroupName('SAM-SA-6-Kilo')
  if sa6 then sa6:setHARMDetectionChance(100) end

  -- The SA-2 goes live early, so the player gets a launch warning well before
  -- the merge instead of a silent site that only wakes at max firing range.
  local sa2 = redIADS:getSAMSiteByGroupName('SAM-SA-2-Mike')
  if sa2 then
    sa2:setEngagementZone(SkynetIADSAbstractRadarElement.GO_LIVE_WHEN_IN_SEARCH_RANGE)
    sa2:setGoLiveRangeInPercent(70)
  end

  redIADS:addRadioMenu()
  redIADS:activate()

  -- These return a SkynetIADSTableDelegator (a proxy carrying its own `__index`
  -- field), so `pairs` counts one phantom entry too many — it reported 4 SAM
  -- sites and 3 EW radars for a mission that has 3 and 2. Use the length
  -- operator, which only sees the array part.
  local sams = #(redIADS:getSAMSites() or {})
  local ewrs = #(redIADS:getEarlyWarningRadars() or {})

  -- Zero SAM sites means the prefix match found nothing: the IADS would be
  -- "active" and completely inert. Fail loudly instead.
  if sams == 0 then error("IADS activated with 0 SAM sites - check group name prefixes") end

  return string.format("samSites=%d ewRadars=%d", sams, ewrs)
end)

say("SETUP", "complete=1")
