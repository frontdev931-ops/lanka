import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { MAX_BYTES } from './file-parser';
import { ImportsService } from './imports.service';

const WRITERS = [Role.OWNER, Role.MANAGER, Role.ADMIN];

@Controller('imports')
@UseGuards(AuthGuard)
export class ImportsController {
  constructor(private imports: ImportsService) {}

  @Get()
  @Roles(...WRITERS)
  history(@CurrentUser() u: AuthUser) {
    return this.imports.history(u.clinicId);
  }

  @Post()
  @Roles(...WRITERS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('bad_file');
    // Имя файла приходит в кодировке latin1 из multipart: возвращаем в UTF-8 для кириллицы
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.imports.upload(u.clinicId, u.userId, name, file.buffer);
  }

  @Get(':id')
  @Roles(...WRITERS)
  preview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.imports.preview(u.clinicId, id);
  }

  @Post(':id/dry-run')
  @Roles(...WRITERS)
  @HttpCode(200)
  dryRun(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() mapping: unknown) {
    return this.imports.dryRun(u.clinicId, id, mapping);
  }

  @Post(':id/apply')
  @Roles(...WRITERS)
  @HttpCode(200)
  apply(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() mapping: unknown) {
    return this.imports.apply(u.clinicId, u.userId, id, mapping);
  }

  @Post(':id/undo')
  @Roles(...WRITERS)
  @HttpCode(200)
  undo(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.imports.undo(u.clinicId, u.userId, id);
  }

  @Get(':id/unmatched.csv')
  @Roles(...WRITERS)
  async unmatched(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const csv = await this.imports.unmatchedCsv(u.clinicId, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="unmatched.csv"');
    res.send(csv);
  }

  @Delete(':id')
  @Roles(...WRITERS)
  @HttpCode(200)
  discard(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.imports.discard(u.clinicId, id);
  }
}
