import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AgentBridgeService } from "./agent-bridge.service.js";
import {
  AgentPollInputSchema,
  AgentQueryInputSchema,
  AgentRegisterInputSchema,
  AgentResultInputSchema,
} from "./agent-bridge.types.js";

@Controller("v1/agent")
export class AgentBridgeController {
  constructor(private readonly bridge: AgentBridgeService) {}

  @Post("register")
  register(@Body() body: unknown) {
    const input = AgentRegisterInputSchema.parse(body);
    return this.bridge.registerAgent(input);
  }

  @Post("poll")
  poll(@Body() body: unknown) {
    const input = AgentPollInputSchema.parse(body);
    return this.bridge.poll(input);
  }

  @Post("result")
  submitResult(@Body() body: unknown) {
    const input = AgentResultInputSchema.parse(body);
    return this.bridge.submitResult(input);
  }

  @Post("query")
  async executeQuery(@Body() body: unknown) {
    const input = AgentQueryInputSchema.parse(body);
    return this.bridge.dispatchQuery(input);
  }

  @Get("status/:pairCode")
  getStatus(@Param("pairCode") pairCode: string) {
    return this.bridge.getStatus(pairCode);
  }
}
