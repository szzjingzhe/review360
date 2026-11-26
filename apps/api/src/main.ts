import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Request, Response, NextFunction } from 'express';

/**
 * 写操作 Origin 校验（技术文档 4.1：同源 API，写操作检查 Origin）。
 * Cookie 会话认证下防止跨站写入；允许的来源为 WEB_ORIGIN（默认本地前端）。
 */
function originCheck(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // 同源导航之外的非浏览器客户端不发送 Origin
    if (origin !== allowedOrigin) {
      res.status(403).json({ code: 'ORIGIN_REJECTED' });
      return;
    }
    next();
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  const webOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
  app.use(originCheck(webOrigin));
  app.enableShutdownHooks();
  // 容器化部署端口可配置；默认保持 3000，监听 0.0.0.0 以便容器外访问
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://0.0.0.0:${port}/api/v1 (origin=${webOrigin})`);
}

bootstrap();
