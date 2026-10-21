import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Bounded so a huge "password" can't make Argon2 hash megabytes per request.
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}
