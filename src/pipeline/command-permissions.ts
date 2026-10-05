import type {AppConfig, CommandId, CommandPermission} from '../core/types.js';
export const COMMAND_DEFINITIONS: Array<{id:CommandId; aliases:string[]; name:string; description:string}> = [
 {id:'help',aliases:['/help','/?'],name:'帮助',description:'查看可用指令'},
 {id:'persona',aliases:['/persona','/人格'],name:'人格',description:'查看或切换当前会话人格'},
 {id:'personas',aliases:['/personas','/人格列表'],name:'人格列表',description:'列出所有可用人格'},
 {id:'memory',aliases:['/memory','/记忆'],name:'记忆',description:'查看关于发送者自己的记忆'},
 {id:'forget',aliases:['/forget','/忘记'],name:'遗忘',description:'删除关于发送者自己的匹配记忆'},
 {id:'emotion',aliases:['/emotion','/情绪'],name:'情绪',description:'查看发送者的情绪状态'},
 {id:'new',aliases:['/new','/新话题'],name:'新话题',description:'新建当前私聊或群的话题'},
 {id:'topics',aliases:['/topics','/话题'],name:'话题',description:'列出或切换当前会话的话题'},
 {id:'stats',aliases:['/stats','/统计'],name:'统计',description:'查看整个机器人的统计'},
 {id:'remind',aliases:['/remind','/提醒'],name:'创建提醒',description:'为本会话创建定时提醒'},
 {id:'reminders',aliases:['/reminders','/提醒列表'],name:'提醒列表',description:'查看自己在本会话的定时提醒'},
 {id:'cancelremind',aliases:['/cancelremind','/取消提醒'],name:'取消提醒',description:'取消自己在本会话的待执行提醒'},
 {id:'daily',aliases:['/daily','/日报'],name:'群聊日报',description:'总结本群24小时记录，或配置每日定时日报'},
];
export function parseCommand(text:string): {id:CommandId;arg:string} | null {
 const match=/^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
 if(!match)return null;
 const id=COMMAND_DEFINITIONS.find(d=>d.aliases.includes(match[1]!.toLowerCase()))?.id;
 return id?{id,arg:match[2]?.trim()??''}:null;
}
export function commandPermission(cfg:AppConfig['trigger'],id:CommandId):CommandPermission {
 return cfg.commandPermissions[id] ?? (cfg.commandAdminOnly || (id==='persona' && cfg.personaAdminOnly)?'admin':'all');
}
export function authorizeCommand(cfg:AppConfig['trigger'],id:CommandId,userId:number):{allowed:boolean;reason?:string} {
 if(cfg.denyUsers.includes(userId))return {allowed:false,reason:'用户在黑名单中'};
 const p=commandPermission(cfg,id);
 if(p==='all'||cfg.admins.includes(userId))return {allowed:true};
 if(p==='whitelist'&&cfg.allowUsers.includes(userId))return {allowed:true};
 return {allowed:false,reason:p==='admin'?'该指令仅限管理员使用':'该指令仅限用户白名单和管理员使用'};
}
