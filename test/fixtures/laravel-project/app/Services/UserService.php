<?php

namespace App\Services;

use App\Models\User;

class UserService
{
    public function create(array $data): User
    {
        return User::create($data);
    }

    public function findById(int $id): ?User
    {
        return User::find($id);
    }

    public function updateEmail(User $user, string $email): bool
    {
        return $user->update(['email' => $email]);
    }
}
