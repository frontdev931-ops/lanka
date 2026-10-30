import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { TwoFactorService } from './two-factor.service';
import { RateLimitService } from './rate-limit.service';
import { AuthGuard } from '../common/auth.guard';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, MailService, RateLimitService, TwoFactorService],
  exports: [AuthGuard, AuthService, MailService, RateLimitService],
})
export class AuthModule {}
