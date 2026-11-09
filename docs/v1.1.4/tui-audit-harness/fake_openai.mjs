import http from "node:http";
const port = +process.argv[2] || 18080;
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const MD = ["## Plan\n\n","The cache sits **between** the loader and the store, with `inline code` and a [link](http://x.y). ","This is a very long line that goes on and on without any natural break point so we can see how the wrapping behaves in narrow terminals 12345678901234567890 and continues even further beyond.\n\n","1. First step\n2. Second step\n   - nested item\n- bullet\n\n","```ts\nexport class Cache<K, V> {\n\tget(k: K) { return this.m.get(k); // a long trailing comment that runs well past the width of a narrow terminal window ok\n\t}\n}\n```\n\n","| Option | Default | Note |\n|---|---|---|\n| size | 512 | entries |\n| ttl | 60 s | per entry |\n\n","> a blockquote\n\n","Emoji ✅ 🚀 café 字符漢字テスト — done.\n"];
function lastUser(m){ for(let i=m.length-1;i>=0;i--) if(m[i].role==="user"){ return [i, typeof m[i].content==="string"?m[i].content:JSON.stringify(m[i].content)]; } return [-1,""]; }
const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
http.createServer((req,res)=>{
  if (req.url.endsWith("/models")) { res.setHeader("content-type","application/json"); return res.end(JSON.stringify({data:[{id:"fake-model"},{id:"other-model"}]})); }
  let raw=""; req.on("data",c=>raw+=c); req.on("end", async ()=>{
    let body={}; try{body=JSON.parse(raw)}catch{}
    const msgs = body.messages||[]; const [ui,u]=lastUser(msgs);
    const tools = msgs.slice(ui+1).filter(m=>m.role==="tool").length;
    console.log(new Date().toISOString(), req.url, "stream="+body.stream, "tools="+tools, JSON.stringify(u).slice(0,80));
    if (!body.stream){ res.setHeader("content-type","application/json"); return res.end(JSON.stringify({choices:[{index:0,message:{role:"assistant",content:"ok summary"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})); }
    const key = (u.match(/SC:(\w+)/)||[])[1]||"default";
    if (key==="e429"){ res.writeHead(429,{"content-type":"application/json","retry-after":"2"}); return res.end(JSON.stringify({error:{message:"Rate limit exceeded",type:"rate_limit"}})); }
    if (key==="e500"){ res.writeHead(500,{"content-type":"application/json"}); return res.end(JSON.stringify({error:{message:"upstream exploded"}})); }
    if (key==="reset"){ return req.socket.destroy(); }
    if (key==="hang"){ res.writeHead(200,{"content-type":"text/event-stream"}); res.write(sse({choices:[{index:0,delta:{content:"starting... "}}]})); return; }
    res.writeHead(200,{"content-type":"text/event-stream"});
    const text=async(chunks,gap=60)=>{ for(const c of chunks){ res.write(sse({choices:[{index:0,delta:{content:c}}]})); await wait(gap);} };
    const call=async(name,args,delay=200)=>{ await wait(delay); res.write(sse({choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_"+tools,type:"function",function:{name,arguments:JSON.stringify(args)}}]}}]})); res.write(sse({choices:[{index:0,delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})); res.end("data: [DONE]\n\n"); };
    const done=()=>{ res.write(sse({choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1000,completion_tokens:200,total_tokens:1200}})); res.end("data: [DONE]\n\n"); };
    const big = Array.from({length:400},(_,i)=>`line ${i} of a big generated file with some content`).join("\n")+"\n";
    switch(key){
      case "md": await text(MD,120); return done();
      case "slow": await text(Array.from({length:60},(_,i)=>`word${i} `),250); return done();
      case "long": await text(["x".repeat(500)+"\n\n"+"lorem ipsum ".repeat(60)+"\n"],10); return done();
      case "many": await text(Array.from({length:200},(_,i)=>`Line ${i}: streamed output for scrollback testing\n\n`),15); return done();
      case "read": if(tools===0) return call("read_file",{path:"README.md"}); await text(["Read it."]); return done();
      case "cmd": if(tools===0) return call("run_command",{command:"for i in $(seq 1 5); do echo step $i; sleep 1; done"}); await text(["Command finished."]); return done();
      case "cmdbig": if(tools===0) return call("run_command",{command:"seq 1 300; echo 'tab\there'; printf '\\033[31mred\\033[0m\\n'"}); await text(["Big output done."]); return done();
      case "cmdlong": if(tools===0) return call("run_command",{command:"sleep 60"}); await text(["Never."]); return done();
      case "write": if(tools===0) return call("write_file",{path:"src/new.ts",content:"export const a = 1;\nexport const b = 2;\n"}); await text(["Created the file."]); return done();
      case "bigwrite": if(tools===0) return call("write_file",{path:"big.txt",content:big}); await text(["Big file created."]); return done();
      case "edit": if(tools===0) return call("edit_file",{path:"README.md",old_content:"A small repository.",new_content:"A modified repository.\nWith a second line."}); await text(["Edited."]); return done();
      case "delete": if(tools===0) return call("delete_file",{path:"base.txt"}); await text(["Deleted."]); return done();
      case "multi": if(tools===0) return call("write_file",{path:"a.txt",content:"A\n"}); if(tools===1) return call("write_file",{path:"b.txt",content:"B\n"}); if(tools===2) return call("run_command",{command:"ls"}); await text(["All done."]); return done();
      case "bad": if(tools===0) return call("nonexistent_tool",{x:1}); await text(["Unknown tool handled."]); return done();
      default: await text(["Hello! This is the fake model reply.\n"],50); return done();
    }
  });
}).listen(port,"127.0.0.1",()=>console.log("fake on",port));
