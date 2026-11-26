import {Body,Controller,Get,Param,Post,Put,UseGuards} from '@nestjs/common';
import {SessionGuard} from './session.guard';
import {CurrentUser,type AuthContext} from './current-user.decorator';
import {CapabilityGuard,RequireCapabilities} from '../authz/capability.guard';
import {FeishuPrebindingService} from './feishu-prebinding.service';
@Controller('auth/feishu/prebindings')
@UseGuards(SessionGuard,CapabilityGuard)
@RequireCapabilities('org.manage')
export class FeishuPrebindingController {
 constructor(private readonly service:FeishuPrebindingService){}
 @Post('preview') async preview(@CurrentUser() actor:AuthContext){return {data:await this.service.preview(actor)};}
 @Get() async list(@CurrentUser() actor:AuthContext){return {data:await this.service.list(actor)};}
 @Get(':id') async detail(@CurrentUser() actor:AuthContext,@Param('id') id:string){return {data:await this.service.detail(actor,id)};}
 @Put(':id/items/:itemId/verification') async verify(@CurrentUser() actor:AuthContext,@Param('id') id:string,@Param('itemId') itemId:string,@Body() body:{confirmed?:unknown;openId?:unknown;evidence?:unknown}){return {data:await this.service.verify(actor,id,itemId,body)};}
 @Post(':id/submit') async submit(@CurrentUser() actor:AuthContext,@Param('id') id:string,@Body() body:{itemIds?:unknown;visibilityConfirmed?:unknown;visibilityEvidence?:unknown}){return {data:await this.service.submit(actor,id,body)};}
}
