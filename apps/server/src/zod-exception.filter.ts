import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

interface HttpResponseLike {
  status: (code: number) => { json: (body: unknown) => unknown };
}

/**
 * Zod doğrulama hatasını 400'e çevirir.
 *
 * Controller'ların çoğu ham `schema.parse(body)` çağırıyordu; yakalanmayan
 * ZodError Nest tarafından 500 sayılıyordu. Bu, istemcinin "girdim hatalı" ile
 * "sunucu bozuldu" durumlarını ayırt etmesini imkânsız kılıyordu.
 *
 * Yanıt yalnızca alan adlarını ve doğrulama mesajlarını taşır; gönderilen ham
 * değerler (ör. API anahtarı) asla geri yansıtılmaz.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter<ZodError> {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const flattened = exception.flatten();
    response.status(400).json({
      statusCode: 400,
      error: 'Bad Request',
      message: 'İstek gövdesi doğrulanamadı',
      details: {
        formErrors: flattened.formErrors,
        fieldErrors: flattened.fieldErrors,
      },
    });
  }
}
