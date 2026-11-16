-- Stock Lua 5.1 mocked protocol/runtime execution. No DCS behavior is verified.
local hook = ...
local queued, current, callbacks, reply, sends = nil, nil, nil, '', 0
log = { INFO=1, ERROR=2, WARNING=3, write=function() end }
local client = {
 settimeout=function() end,
 receive=function() local v=queued;queued=nil;return v and 'request' or nil, 'closed' end,
 send=function(_, text, first)
  first=first or 1; local last=math.min(first+10,#text); reply=reply..text:sub(first,last);sends=sends+1
  if last<#text then return nil,'timeout',last end
  return last
 end,
 close=function() end,
}
local server={setoption=function()return true end,bind=function(_,host)assert(host=='127.0.0.1');return true end,listen=function()return true end,settimeout=function()end,accept=function()if queued then return client end end,close=function()end}
package.loaded.socket={tcp=function()return server end}
local groupName='Quoted "group"\nnext'; local flagName='flag"name'
local unit={getName=function()return 'Aircraft-1' end,getTypeName=function()return 'F-16C_50' end,getPoint=function()return{x=1,y=2,z=3}end,getVelocity=function()return{x=5,y=6,z=7}end,getLife=function()return 100 end,getLife0=function()return 100 end,inAir=function()return true end,isActive=function()return true end}
Group={getByName=function(name)if name==groupName then return{isExist=function()return true end,getUnits=function()return{unit}end}end end}
trigger={misc={getUserFlag=function(name)assert(name==flagName);return 7 end}}
timer={getTime=function()return 42 end};env={mission={theatre='Caucasus'}}
DCSMCP_ACCEPTANCE={runId='test-run',scenarioId='test-case'}
DCSMCP={eventSequence=3,events={{sequence=1,kind='takeoff'},{sequence=2,kind='hit'},{sequence=3,kind='dead'}}}
DCS={setUserCallbacks=function(cb)callbacks=cb end};Gui={AddUpdateCallback=function()end}
net={json2lua=function()return current end,dostring_in=function(state,source)assert(state=='mission');return assert(loadstring(source))()end}
assert(loadfile(hook))();assert(callbacks);callbacks.onSimulationStart()
local function request(req)
 current=req;queued=true;reply='';sends=0
 for i=1,1500 do callbacks.onSimulationFrame() end
 assert(reply:sub(-1)=='\n','response was incomplete');assert(sends>1,'partial-write path was not exercised');return reply
end
local response=request{cmd='runtime',args={groups={groupName,'Missing'},flags={flagName},afterSequence=1}}
assert(response:find('"ok":true',1,true));assert(response:find('"Aircraft-1"',1,true));assert(response:find('"inAir":true',1,true));assert(response:find('"exists":false',1,true));assert(response:find('"available":true',1,true));assert(response:find('"sequence":2',1,true));assert(not response:find('"sequence":1',1,true));assert(response:find('"flag\\"name":7',1,true))
DCSMCP=nil
response=request{cmd='runtime',args={}};assert(response:find('"available":false',1,true))
response=request{cmd='exec',args={code='error("unapproved")'}};assert(response:find('"ok":false',1,true))
local many={};for i=1,101 do many[i]='group' end
response=request{cmd='runtime',args={groups=many}};assert(response:find('"ok":false',1,true))
callbacks.onMissionLoadError('synthetic load error')
response=request{cmd='status'};assert(response:find('synthetic load error',1,true))
callbacks.onSimulationStop();print('HOOK_RUNTIME_OK (mocks only; partial writes, flags, unit state, event cursor, load errors, raw-exec gate)')
