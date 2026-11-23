const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), os = require('node:os');
const { spawn } = require('node:child_process');
const { connect, sleep } = require('./fixtures/cdp.cjs');
const { name, build, version } = require('../package.json');
const catalina = name === 'hongguo-catalina';
const [,, bundle, receipt] = process.argv;
const arch = process.arch;
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-mac-check-'));
(async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const profile=path.join(qa,'profile'), media=path.join(qa,'media');
  fs.mkdirSync(profile); fs.mkdirSync(media);
  fs.writeFileSync(path.join(profile, 'data.json'), JSON.stringify({settings:{root:media,app_updates_enabled:false,watch_updates_enabled:false}}));
  const exe=path.join(bundle,'Contents/MacOS',build.productName);
  const log=fs.openSync(path.join(qa,'app.log'),'w');
  const child=spawn(exe,[
    '--mute-audio','--lang=zh-CN','--user-data-dir='+profile,'--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port], {stdio:['ignore',log,log]});
  fs.closeSync(log);
  child.on('exit',(code, signal)=>console.log(JSON.stringify({arch,exit:code,signal})));
  let cdp;
  try {
    for (let attempt=0;attempt<3&&!cdp;attempt++){
      try { cdp=await connect(port); } catch(e){ if(child.exitCode!==null||child.signalCode||attempt===2)throw e; }
    }
    const startup=await cdp.evaluate(`(async()=>{for(let i=0;i<100;i++){
      if(document.querySelector('.footer-note')?.textContent.includes(${JSON.stringify('v'+version)}))return {
        version:(await window.electronAPI.getAppInfo()).version, updater:typeof window.electronAPI.checkAppUpdate,
        announcements:typeof window.electronAPI.checkAnnouncements };
      await new Promise(r=>setTimeout(r,100));
    }throw Error('Version could not be verified');})()`);
    assert.deepEqual(startup,{version,updater:'function',announcements:'undefined'});
    console.log(JSON.stringify({arch,...startup}));
    if (catalina) {
      const edition = await cdp.evaluate(`(async()=>({
        edition: (await window.electronAPI.getAppInfo()).catalina,
        updater: (await window.electronAPI.getAppUpdateState()).supported,
        publicUpdate: (await window.electronAPI.checkAppUpdate()).enabled
      }))()`);
      assert.deepEqual(edition, { edition: true, updater: false, publicUpdate: false });
    }
    let playback;
    if (arch === 'arm64') playback = await cdp.evaluate(`(async()=>{
      const api=window.electronAPI, wait=ms=>new Promise(r=>setTimeout(r,ms));
      localStorage.setItem('hongguo:playback-preferences','{"rate":1,"volume":0,"muted":true}');
      let rows=[];
      for(const request of [{category:'hot-real-drama',catalogChannel:'app'},{category:'hot-drama',catalogChannel:'web'}]){
        try {
          const found=await api.browseList({source:'hongguo',forceRefresh:true,...request});
          if(found.success&&found.results?.length){rows=[...found.results];break;}
        } catch {}
      }
      if(!rows.length)throw Error('Real Hongguo catalog is unavailable');
      for(let i=rows.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rows[i],rows[j]]=[rows[j],rows[i]];}
      async function until(fn,ms,message){
        const end=Date.now()+ms;
        while(Date.now()<end){const x=await fn();if(x)return x;await wait(150);}
        throw Error(message);
      }
      let error='No eligible drama';
      for(const drama of rows.slice(0,5)){
        const id=String(drama.series_id), detail=await api.searchResolve(id);
        if(!detail.success)continue;
        const episodes=(detail.data?.episodes||[]).filter(e=>!e.locked&&e.vid_index>0).slice(0,2);
        if(episodes.length<2)continue;
        const states=[];
        try{
          for(const {vid_index:index} of episodes){
            const submit=await api.downloadSingleEpisode(id,index,'auto');
            if(!submit.success)throw Error('Real download not accepted');
            const task=await until(async()=>{const t=(await api.getDownloadTasks()).find(t=>String(t.hongguoInfo?.series_id)===id&&Number(t.hongguoInfo?.vid_index)===index);
              if(t&&['failed','stopped'].includes(t.status))throw Error('Real download failed');
              return t?.status==='completed'&&t.receivedBytes>0?t:null;},75000,'Real download timed out');
            const previous=document.querySelector('.player-video')?.currentSrc;
            if(!(await api.playSeries({seriesId:id,vidIndex:index})).success)throw Error('Could not open downloaded episode');
            const v=await until(()=>{const node=document.querySelector('.player-video');return node?.readyState>=2&&node.currentSrc.startsWith('hongguo-local:')&&node.currentSrc!==previous?node:null;},15000,'Local video never became ready');
            if(!v.muted||v.volume!==0){v.pause();throw Error('The player was not muted on startup');}
            v.currentTime=0;
            await v.play();
            await until(()=>v.currentTime>=10&&v.getVideoPlaybackQuality().totalVideoFrames>0,30000,'Actual playback did not reach ten seconds');
            v.pause();
            if(!v.muted||v.volume!==0||!v.paused||!v.videoWidth||v.error)throw Error('Actual playback did not pass verification');
            states.push({episode:index,time:v.currentTime,muted:v.muted,volume:v.volume,paused:v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight,bytes:task.receivedBytes});
          }
          return {title:drama.series_title,states};
        }catch(e){document.querySelector('.player-video')?.pause();error=e.message;}
      }
      throw Error(error);
    })()`,420000);
    if (playback) assert.equal(playback.states.length,2);
    const proof={arch,system:os.release(),launch:true,version,sourceCommit:process.env.GITHUB_SHA,playback};
    fs.writeFileSync(receipt,JSON.stringify(proof,null,2)+'\n');
    console.log(JSON.stringify(proof));
  } finally {
    try{cdp?.close();}catch{}
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2000)]);
    fs.rmSync(qa,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
