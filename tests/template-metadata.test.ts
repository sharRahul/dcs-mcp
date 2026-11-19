import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {meSiteTemplates} from '../src/dcs/me-templates.js';
import {findSiteTemplate} from '../src/miz/templates.js';
test('editor guns, radars, searchlights and mortars do not claim SAM compatibility',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'template-'));
 try {mkdirSync(path.join(dir,'MissionEditor/data/scripts'),{recursive:true});
 writeFileSync(path.join(dir,'MissionEditor/data/scripts/templates.lua'), 'templates = { ["Searchlight Battery"]={units={[1]={name="Flakscheinwerfer_37"}}}, ["FLAK18 BATTERY"]={units={[1]={name="flak18"}}}, ["Radar Site"]={units={[1]={name="FuMG-401"}}}, ["mortar crew"]={units={[1]={name="2B11 mortar"}}}, ["SA-2 SAM Battery"]={units={[1]={name="S_75M_Volhov"}}} }');
 const t=meSiteTemplates(dir) as any[];
 for(const id of ['me-searchlight-battery','me-flak18-battery','me-radar-site','me-mortar-crew']) assert.equal(t.find(x=>x.id===id).skynetRole,'none');
 assert.equal(t.find(x=>x.id==='me-flak18-battery').siteCategory,'gun');
 assert.equal(t.find(x=>x.id==='me-sa-2-sam-battery').siteCategory,'sam');
 assert.equal(t[0].geometry.kind,'editor-authored');assert.equal(t[0].execution.status,'unverified');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a flown generic column is not promoted to an editor or historical layout',()=>{
 const t=findSiteTemplate('SA-2') as any;
 assert.equal(t.geometry.kind,'generic-column');assert.equal(t.execution.status,'engaged');
 assert.equal(t.historicalCompleteness,'unknown');assert.equal(t.geometry.individualHeadings,false);
});
