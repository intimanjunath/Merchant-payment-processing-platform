import { Controller, Get } from '@nestjs/common';

import { OPENAPI_DOCUMENT } from './openapi';

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document(): typeof OPENAPI_DOCUMENT {
    return OPENAPI_DOCUMENT;
  }
}
