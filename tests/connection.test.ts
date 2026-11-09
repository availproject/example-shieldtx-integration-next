import { expect, test } from "bun:test";
import { openShieldTxWindow } from "../src/connection";

test("popup handoff checks source/origin/correlation and sends a token only on explicit request",async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,"window");
  const listeners=new Set<(event:MessageEvent)=>void>();
  const sent:{value:unknown;origin:string}[]=[];
  let target="",closed=false,tokens=0;
  const popup={get closed(){return closed;},close:()=>{closed=true;},postMessage:(value:unknown,origin:string)=>sent.push({value,origin})};
  const fake={open:(url:string)=>{target=url;return popup;},addEventListener:(_type:string,fn:(event:MessageEvent)=>void)=>listeners.add(fn),removeEventListener:(_type:string,fn:(event:MessageEvent)=>void)=>listeners.delete(fn)};
  Object.defineProperty(globalThis,"window",{configurable:true,value:fake});
  const abort=new AbortController();
  try{
    const done=openShieldTxWindow({origin:"https://shieldtx.example",request:{operation:"connect"},getAccessToken:async()=>{tokens++;return "requester-token";},isCurrent:()=>true,signal:abort.signal});
    const requestId=new URL(target).searchParams.get("requestId");
    const dispatch=(data:unknown,origin="https://shieldtx.example",source:unknown=popup)=>{
      for(const listener of listeners)listener({data,origin,source} as MessageEvent);
    };
    dispatch({type:"shieldtx:ready",requestId},"https://evil.example");
    dispatch({type:"shieldtx:ready",requestId},"https://shieldtx.example",{});
    dispatch({type:"shieldtx:ready",requestId:crypto.randomUUID()});
    expect(sent).toHaveLength(0);expect(tokens).toBe(0);
    dispatch({type:"shieldtx:ready",requestId});
    expect(sent).toEqual([{value:{type:"shieldtx:init",requestId,request:{operation:"connect"}},origin:"https://shieldtx.example"}]);
    expect(target).not.toContain("token");expect(tokens).toBe(0);
    dispatch({type:"shieldtx:token-request",requestId});
    await Promise.resolve();await Promise.resolve();
    expect(tokens).toBe(1);expect(sent.at(-1)?.value).toEqual({type:"shieldtx:authorize",requestId,token:"requester-token"});
    dispatch({type:"shieldtx:complete",requestId,result:null});
    expect(await done).toBeNull();expect(closed).toBe(true);expect(listeners.size).toBe(0);
  }finally{abort.abort();if(original)Object.defineProperty(globalThis,"window",original);else Reflect.deleteProperty(globalThis,"window");}
});

test("account cancellation closes the pending popup without sending a token",async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,"window");let closed=false;
  const popup={closed:false,close:()=>{closed=true;},postMessage:()=>{throw new Error("No handoff expected");}};
  Object.defineProperty(globalThis,"window",{configurable:true,value:{open:()=>popup,addEventListener:()=>{},removeEventListener:()=>{}}});
  const abort=new AbortController();
  try{
    const done=openShieldTxWindow({origin:"https://shieldtx.example",request:{operation:"connect"},getAccessToken:async()=>{throw new Error("No token expected");},isCurrent:()=>true,signal:abort.signal});
    abort.abort();await expect(done).rejects.toThrow("cancelled");expect(closed).toBe(true);
  }finally{if(original)Object.defineProperty(globalThis,"window",original);else Reflect.deleteProperty(globalThis,"window");}
});
