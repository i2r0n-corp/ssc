'use strict';
const fs=require('fs'),zlib=require('zlib'),path=require('path');
const buf=fs.readFileSync(path.join(__dirname,'..','data','ListTemplate.pptx'));
let off=0;
while(off<buf.length-4){
  if(buf[off]===0x50&&buf[off+1]===0x4B&&buf[off+2]===0x03&&buf[off+3]===0x04){
    const cm=buf.readUInt16LE(off+8),cs=buf.readUInt32LE(off+18),nl=buf.readUInt16LE(off+26),el=buf.readUInt16LE(off+28);
    const nm=buf.slice(off+30,off+30+nl).toString();
    const ds=off+30+nl+el;
    if(nm==='ppt/slides/slide1.xml'){
      const xml=(cm===8?zlib.inflateRawSync(buf.slice(ds,ds+cs)):buf.slice(ds,ds+cs)).toString();
      // find all data rows (skip header rows 0 and 1)
      const trRe=/<a:tr\s+h="(\d+)">([\s\S]*?)<\/a:tr>/g;
      let m, ri=0;
      while((m=trRe.exec(xml))!==null){
        const rowXml=m[2];
        const tcRe=/<a:tcPr([^>]*)>/g;
        let tc, ci=0;
        while((tc=tcRe.exec(rowXml))!==null){
          const a=tc[1];
          const g=k=>{const x=a.match(new RegExp(k+'="(\\d+)"'));return x?x[1]:'—';};
          console.log('row'+ri+' cell'+ci+': h='+m[1]+' marL='+g('marL')+' marR='+g('marR')+' marT='+g('marT')+' marB='+g('marB')+' anchor='+g('anchor'));
          ci++;
        }
        ri++;
      }
      break;
    }
    off=ds+cs;
  } else off++;
}
