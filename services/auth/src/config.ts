// ABOUTME: Читает явную конфигурацию автономного сервиса авторизации.
// ABOUTME: Не содержит адресов экземпляра и не выводит секреты.
export interface Config { databaseURL:string; secret:string; origin:string; trustedOrigins:string[]; emailFrom:string; resendKey:string; natsServers:string[]; natsUser?:string; natsPassword?:string; natsCredsFile?:string; natsCAFile?:string; }
/** Проверяет необходимые входы запуска; бросает ошибку с именем отсутствующего параметра. */
export function config(env:NodeJS.ProcessEnv=process.env, mode:"runtime"|"migration"="runtime"):Config {
 const required=(key:string)=>{const value=env[key];if(!value)throw new Error(`Missing ${key}`);return value;};
 const validateOrigin=(value:string,key:string)=>{try {const url=new URL(value);if(!["http:","https:"].includes(url.protocol)||url.origin!==value||url.username||url.password||url.hostname.includes("*"))throw new Error();}catch{throw new Error(`${key} must contain full http(s) origins`);}return value;};
 const origin=validateOrigin(required("AUTH_ORIGIN"),"AUTH_ORIGIN");
 const trustedOrigins=[...new Set([origin,...(env.AUTH_TRUSTED_ORIGINS === undefined ? [] : env.AUTH_TRUSTED_ORIGINS.split(",").map(value=>validateOrigin(value.trim(),"AUTH_TRUSTED_ORIGINS")))])];
 const secret=required("AUTH_SECRET"); if(secret.length<32)throw new Error("AUTH_SECRET requires 32 characters");
 return {databaseURL:required("AUTH_DATABASE_URL"),secret,origin,trustedOrigins,emailFrom:required("AUTH_EMAIL_FROM"),resendKey:mode==="runtime"?required("RESEND_API_KEY"):"",natsServers:mode==="runtime"?(env.NATS_SERVERS??required("NATS_URL")).split(","):[],natsUser:env.NATS_USER,natsPassword:env.NATS_PASSWORD,natsCredsFile:env.NATS_CREDS_FILE,natsCAFile:env.NATS_CA_FILE};
}
