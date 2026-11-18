local f=assert(io.open(arg[1],'r')); local hook=f:read('*a'); f:close()
local source=assert(hook:match('local AIRCRAFT_SRC = %[%=%=%[(.-)%]%=%=%]'),'aircraft module missing')
local now, handler, flags = 100, nil, {}
timer={getTime=function() return now end}
Controller={Detection={VISUAL=1,OPTIC=2,RADAR=4,IRST=8,RWR=16,DLINK=32}}
world={event={S_EVENT_LAND=4,S_EVENT_TAKEOFF=3,S_EVENT_DEAD=8,S_EVENT_CRASH=5,S_EVENT_BIRTH=15},addEventHandler=function(h) handler=h end}
trigger={action={setUserFlag=function(k,v) flags[k]=v end},misc={getUserFlag=function(k) return flags[k] or 0 end}}
local current, writes, queue = {}, {}, {}
local ctrl={
 getDetectedTargets=function(self,...) local a={...}; assert(a[1]==4,'must use enum RADAR=4'); return current end,
 isTargetDetected=function(self,o,...) return true,o.visible,o.lastTime,o.typeKnown,o.distanceKnown,o.lastPos,o.lastVel end,
 hasTask=function() return #queue>0 end,
 setTask=function(self,t) queue={t} end,
 pushTask=function(self,t) table.insert(queue,1,t) end,
 popTask=function() table.remove(queue,1) end,
 resetTask=function() queue={} end,
 setOption=function(self,k,v) writes[#writes+1]={k,v} end,
}
local units={}; local groups={};local unitSerial=0
local function unit(name,x,z,air)
 unitSerial=unitSerial+1
 local u={name=name,p={x=x,y=100,z=z},air=air,active=true,life=100,id=unitSerial}
 function u:getID() return self.id end
 function u:getName() return self.name end
 function u:getPoint() return self.p end
 function u:isExist() return true end
 function u:isActive() return self.active end
 function u:getLife() return self.life end
 function u:inAir() return self.air end
 function u:getFuel() return .5 end
 units[name]=u; return u
end
local flight=unit('Flight-1',0,0,true)
local troop=unit('Troops-1',1000,0,false)
local function group(name,list,category)
 local g={list=list}
 function g:isExist() return true end
 function g:getUnits() return self.list end
 function g:getController() return ctrl end
 function g:getCategory() return category or 0 end
 groups[name]=g; return g
end
group('Flight',{flight});group('Troops',{troop},2)
Group={getByName=function(n) return groups[n] end,Category={AIRPLANE=0,HELICOPTER=1}}
Unit={getByName=function(n) return units[n] end}
env={mission={coalition={blue={country={{plane={group={{name='Flight',task='AWACS',units={{name='Flight-1'}},route={points={{task={id='ComboTask',params={tasks={{id='WrappedAction',params={action={id='Option',params={name=1,value=2}}}}}}}}}}}}}}}}}}}
assert(loadstring(source))()
local function call(a) return DCSMCP_AIRCRAFT.dispatch(a) end
local target={visible=true,typeKnown=false,distanceKnown=false}
function target:getID() return 99 end
function target:getPoint() error('world-truth position leak') end
function target:getVelocity() error('world-truth velocity leak') end
function target:getName() error('world-truth name leak') end
function target:getCoalition() error('world-truth coalition leak') end
function target:getTypeName() error('unknown type leak') end
current={{object=target,visible=true,type=false,distance=false}}
local a=call({operation='detect',group='Flight',methods={'RADAR'},maxAgeSeconds=300})
assert(#a.contacts==1 and a.contacts[1].id==99 and a.contacts[1].position==nil and a.contacts[1].typeName==nil)
assert(a.contacts[1].lastSeenAt==100)
target.visible=false;target.lastTime=100;target.lastPos={x=1,y=2,z=3};now=110
a=call({operation='detect',group='Flight',methods={'RADAR'},maxAgeSeconds=300})
assert(a.contacts[1].stale and a.contacts[1].lastPosition.x==1 and a.contacts[1].lastSeenAt==100)
current={};now=120
a=call({operation='detect',group='Flight',methods={'RADAR'},maxAgeSeconds=300})
assert(a.contacts[1].stale and a.contacts[1].lastSeenAt==100 and not a.contacts[1].reportedNow)
now=500;a=call({operation='detect',group='Flight',methods={'RADAR'},maxAgeSeconds=300});assert(#a.contacts==0)
local opt=call({operation='options',group='Flight'})
assert(#opt.authoredOptions==1 and opt.currentOptionsAvailable==false)
call({operation='set_option',group='Flight',option='reaction',value=5});assert(writes[1][1]==1 and writes[1][2]==5)
assert(not pcall(call,{operation='set_option',group='Flight',option='roe',value=5}))
call({operation='task',group='Flight',action='set',task={kind='awacs'}});assert(queue[1].id=='AWACS')
local orbit={kind='orbit',point={x=10,y=20},pattern='Circle',altitudeMetres=6000,speedMps=150}
call({operation='task',group='Flight',action='suspend',task=orbit});assert(queue[1].id=='ControlledTask' and queue[2].id=='AWACS')
local flag=queue[1].params.stopCondition.userFlag
call({operation='task',group='Flight',action='resume'});assert(flags[flag]==true or flags[flag]==1)
assert(not pcall(call,{operation='task',group='Flight',action='push',task={kind='script',code='evil()'}}))
call({operation='task',group='Flight',action='reset'});assert(#queue==0)
local zone={x=0,y=0,radiusMetres=200}
call({operation='monitor_register',name='Support',group='Flight',role='AWACS',station=zone,recovery={x=5000,y=0,radiusMetres=200},returningFlag='return'})
assert(handler,'registration must explicitly install event monitoring')
a=call({operation='monitor_inspect',name='Support'});assert(a.state=='on_station' and a.serviceAvailable==nil)
flags['return']=1;a=call({operation='monitor_inspect',name='Support'});assert(a.state=='returning')
flight.air=false;flight.p.x=5000
a=call({operation='monitor_inspect',name='Support'});assert(a.state~='landed','ground position alone is not landing')
handler:onEvent({id=4,time=now,initiator=flight})
a=call({operation='monitor_inspect',name='Support'});assert(a.state=='landed')
call({operation='monitor_register',name='Lift',group='Flight',role='transport',pickup={x=5000,y=0,radiusMetres=200},drop={x=10000,y=0,radiusMetres=200},troops='Troops',loadedFlag='loaded'})
a=call({operation='transport',name='Lift'});assert(a.pickupArrived and a.loading.status=='unknown')
groups.Troops=nil;a=call({operation='transport',name='Lift'});assert(a.loading.status=='unknown','disappearance does not prove boarding')
flags.loaded=1;a=call({operation='transport',name='Lift'});assert(a.loading.status=='scenario_reported')
group('Troops',{troop},2);troop.p.x=10000
a=call({operation='transport',name='Lift'});assert(a.unloading.status=='observed_at_destination')
troop.life=0;a=call({operation='transport',name='Lift'});assert(a.unloading.status~='observed_at_destination','dead troops are not delivered')
assert(not pcall(call,{operation='monitor_register',name='Bad',group='Flight',role='transport',pickup={x=0,y=0,radiusMetres=-1}}))
call({operation='monitor_remove',name='Lift'});assert(not pcall(call,{operation='transport',name='Lift'}))
flight.air=nil
assert(call({operation='monitor_inspect',name='Support'}).state~='landed','unknown inAir is not ground confirmation')
call({operation='monitor_register',name='UnknownLift',group='Flight',role='transport',pickup={x=5000,y=0,radiusMetres=200},drop={x=10000,y=0,radiusMetres=200}})
assert(not call({operation='transport',name='UnknownLift'}).pickupArrived,'unknown inAir is not pickup arrival')
call({operation='monitor_remove',name='UnknownLift'})
flight.air=false;flight.life=0;handler:onEvent({id=8,time=now,initiator=flight})
flight=unit('Flight-1',5000,0,false);groups.Flight.list={flight}
a=call({operation='monitor_inspect',name='Support'})
assert(a.state~='failed' and a.state~='landed','replacement aircraft must not inherit loss or landing evidence')
-- Re-registration must not reuse earlier landing evidence, even at the same model time.
call({operation='monitor_register',name='Support',group='Flight',role='AWACS',recovery={x=5000,y=0,radiusMetres=200}})
assert(call({operation='monitor_inspect',name='Support'}).state~='landed')
handler:onEvent({id=4,time=now,initiator=flight})
assert(call({operation='monitor_inspect',name='Support'}).state=='landed')
handler:onEvent({id=15,time=now,initiator=flight})
assert(call({operation='monitor_inspect',name='Support'}).state~='landed','birth invalidates earlier landing even with a reused ID')
for i=1,501 do handler:onEvent({id=3,time=now+i,initiator=flight}) end
assert(call({operation='monitor_inspect',name='Support'}).eventHistoryGap)
assert(call({operation='monitor_inspect',name='Support'}).state~='landed')
-- New mission scripting state has no monitor or bridge-write history.
DCSMCP_AIRCRAFT=nil;assert(loadstring(source))()
assert(not pcall(call,{operation='monitor_inspect',name='Support'}))
assert(#call({operation='options',group='Flight'}).bridgeWrites==0)
print('AIRCRAFT_RUNTIME_OK')
