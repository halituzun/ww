import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from "@nestjs/common";
import { ZodError } from "zod";
import { StoredRecordError, RepositoryNotFoundError, RepositoryConflictError } from "@ww/db";

interface HttpResponseLike {
  status: (code: number) => { json: (body: unknown) => unknown };
}

@Catch(ZodError, StoredRecordError, RepositoryNotFoundError, RepositoryConflictError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();

    if (exception instanceof ZodError) {
      const flattened = exception.flatten();
      response.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: "İstek gövdesi veya parametresi doğrulanamadı",
        details: {
          formErrors: flattened.formErrors,
          fieldErrors: flattened.fieldErrors,
        },
      });
      return;
    }

    if (exception instanceof RepositoryNotFoundError) {
      response.status(404).json({
        statusCode: 404,
        error: "Not Found",
        message: exception.message || "Kayıt bulunamadı",
      });
      return;
    }

    if (exception instanceof RepositoryConflictError) {
      response.status(409).json({
        statusCode: 409,
        error: "Conflict",
        message: exception.message || "Kayıt çakışması",
      });
      return;
    }

    if (exception instanceof StoredRecordError) {
      response.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        message: exception.message || "Geçersiz parametre veya kayıt formatı",
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    response.status(500).json({
      statusCode: 500,
      error: "Internal Server Error",
      message: exception instanceof Error ? exception.message : "Bilinmeyen sunucu hatası",
    });
  }
}
