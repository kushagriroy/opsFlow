import dotenv from 'dotenv';
import { resolve } from 'node:path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
const prisma=new PrismaClient();
async function main(){
 const pass=await argon2.hash('OpsFlow-Demo-2026!',{type:argon2.argon2id});
 const specs=[['Alex Morgan','admin@opsflow.local','ADMIN'],['Sam Rivera','lead@opsflow.local','TEAM_LEAD'],['Jamie Chen','member@opsflow.local','MEMBER'],['Taylor Brooks','viewer@opsflow.local','VIEWER']] as const;
 const users=[];for(const [name,email] of specs)users.push(await prisma.user.upsert({where:{email},update:{name,passwordHash:pass},create:{name,email,passwordHash:pass}}));
 const teamSpecs=[['Engineering','Product engineering and platform operations.'],['Support','Customer issues and escalations.'],['Finance','Payments and reconciliation.'],['Compliance','Regulatory and compliance requests.']] as const;
 const teams=[];for(const [name,description]of teamSpecs)teams.push(await prisma.team.upsert({where:{name},update:{description},create:{name,description}}));
 for(const [i,t]of teams.entries())for(const [j,u]of users.entries())await prisma.teamMembership.upsert({where:{teamId_userId:{teamId:t.id,userId:u.id}},update:{role:j===0?'ADMIN':j===1?'TEAM_LEAD':j===3?'VIEWER':'MEMBER'},create:{teamId:t.id,userId:u.id,role:j===0?'ADMIN':j===1?'TEAM_LEAD':j===3?'VIEWER':'MEMBER'}});
 const scopedSpecs=[['Engineering Demo Member','engineering-only@opsflow.local',teams[0]!],['Support Demo Member','support-only@opsflow.local',teams[1]!]] as const;
 for(const [name,email,team] of scopedSpecs){const user=await prisma.user.upsert({where:{email},update:{name,passwordHash:pass},create:{name,email,passwordHash:pass}});await prisma.teamMembership.upsert({where:{teamId_userId:{teamId:team.id,userId:user.id}},update:{role:'MEMBER'},create:{teamId:team.id,userId:user.id,role:'MEMBER'}});}
 if(await prisma.workItem.count()===0){const rows=[['Investigate elevated API latency','Platform p95 latency rose after the latest deploy. Check traces and identify the regression.','IN_PROGRESS','URGENT',0,1,-1],['Reconcile duplicate payment captures','Review customer reports and payment processor settlement records.','OPEN','HIGH',2,2,-2],['Refresh SOC 2 evidence pack','Collect current access review and change management evidence.','IN_REVIEW','MEDIUM',3,1,5],['Escalate delayed enterprise onboarding','Coordinate the blocked identity verification with the customer team.','BLOCKED','HIGH',1,2,-3],['Review Q4 vendor invoices','Match invoices against purchase orders and flag discrepancies.','OPEN','LOW',2,null,6],['Rotate staging signing credentials','Rotate exposed staging credentials and document the incident.','RESOLVED','MEDIUM',0,2,-4]] as const;
 for(const [i,r]of rows.entries()){const item=await prisma.workItem.create({data:{reference:`OPS-${String(4100+i)}`,title:r[0],description:r[1],status:r[2],priority:r[3],teamId:teams[r[4]]!.id,assigneeId:r[5]===null?null:users[r[5]]!.id,createdById:users[0]!.id,dueAt:new Date(Date.now()+r[6]*86400000),resolvedAt:r[2]==='RESOLVED'?new Date():null}});await prisma.activityLog.create({data:{workItemId:item.id,actorId:users[0]!.id,action:'CREATED',newValues:{title:item.title,status:item.status,priority:item.priority}}});await prisma.comment.create({data:{workItemId:item.id,authorId:users[1]!.id,content:i===0?'Please attach the traces from the last two releases.':`Initial review for ${item.reference} is underway.`}});}
 }
 console.log(`Seeded ${teams.length} teams and ${users.length+scopedSpecs.length} demo accounts.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>prisma.$disconnect());
