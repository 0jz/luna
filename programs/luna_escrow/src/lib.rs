use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("3rqUcLXu1AwuCKNcjYMtqFiw8t94zUkVhn42PftWJen4");

#[program]
pub mod luna_escrow {
    use super::*;

    pub fn open_campaign(
        ctx: Context<OpenCampaign>,
        amount_lamports: u64,
        brief_hash: [u8; 32],
        approval_deadline: i64,
    ) -> Result<()> {
        require!(amount_lamports > 0, LunaEscrowError::InvalidAmount);
        require!(approval_deadline > Clock::get()?.unix_timestamp, LunaEscrowError::InvalidDeadline);

        let escrow = &mut ctx.accounts.escrow;
        escrow.brand = ctx.accounts.brand.key();
        escrow.creator = ctx.accounts.creator.key();
        escrow.amount_lamports = amount_lamports;
        escrow.brief_hash = brief_hash;
        escrow.approval_deadline = approval_deadline;
        escrow.state = CampaignState::Funded;
        escrow.bump = ctx.bumps.escrow;

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.brand.to_account_info(),
                    to: escrow.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        emit!(CampaignOpened {
            escrow: escrow.key(),
            brand: escrow.brand,
            creator: escrow.creator,
            amount_lamports,
            brief_hash,
        });

        Ok(())
    }

    pub fn mark_delivered(ctx: Context<CreatorAction>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.creator == ctx.accounts.creator.key(), LunaEscrowError::Unauthorized);
        require!(escrow.state == CampaignState::Funded, LunaEscrowError::InvalidState);
        escrow.state = CampaignState::Delivered;

        emit!(CampaignDelivered { escrow: escrow.key() });
        Ok(())
    }

    pub fn approve_and_release(ctx: Context<ApproveAndRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.brand == ctx.accounts.brand.key(), LunaEscrowError::Unauthorized);
        require!(escrow.creator == ctx.accounts.creator.key(), LunaEscrowError::Unauthorized);
        require!(escrow.state == CampaignState::Delivered, LunaEscrowError::InvalidState);

        release_to_creator(escrow, &ctx.accounts.creator.to_account_info())?;
        escrow.state = CampaignState::Released;

        emit!(CampaignReleased { escrow: escrow.key(), creator: escrow.creator });
        Ok(())
    }

    pub fn refund_after_deadline(ctx: Context<RefundAfterDeadline>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.brand == ctx.accounts.brand.key(), LunaEscrowError::Unauthorized);
        require!(escrow.state != CampaignState::Released, LunaEscrowError::InvalidState);
        require!(Clock::get()?.unix_timestamp > escrow.approval_deadline, LunaEscrowError::DeadlineNotReached);

        release_to_brand(escrow, &ctx.accounts.brand.to_account_info())?;
        escrow.state = CampaignState::Refunded;

        emit!(CampaignRefunded { escrow: escrow.key(), brand: escrow.brand });
        Ok(())
    }

    pub fn dispute(ctx: Context<BrandAction>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.brand == ctx.accounts.brand.key(), LunaEscrowError::Unauthorized);
        require!(escrow.state == CampaignState::Delivered, LunaEscrowError::InvalidState);
        escrow.state = CampaignState::Disputed;

        emit!(CampaignDisputed { escrow: escrow.key() });
        Ok(())
    }
}

fn release_to_creator(escrow: &mut Account<CampaignEscrow>, creator: &AccountInfo) -> Result<()> {
    **escrow.to_account_info().try_borrow_mut_lamports()? -= escrow.amount_lamports;
    **creator.try_borrow_mut_lamports()? += escrow.amount_lamports;
    Ok(())
}

fn release_to_brand(escrow: &mut Account<CampaignEscrow>, brand: &AccountInfo) -> Result<()> {
    **escrow.to_account_info().try_borrow_mut_lamports()? -= escrow.amount_lamports;
    **brand.try_borrow_mut_lamports()? += escrow.amount_lamports;
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount_lamports: u64, brief_hash: [u8; 32])]
pub struct OpenCampaign<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,
    /// CHECK: Creator receives funds when the brand approves delivery.
    #[account(mut)]
    pub creator: AccountInfo<'info>,
    #[account(
        init,
        payer = brand,
        space = 8 + CampaignEscrow::INIT_SPACE,
        seeds = [b"campaign", brand.key().as_ref(), brief_hash.as_ref()],
        bump
    )]
    pub escrow: Account<'info, CampaignEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatorAction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub escrow: Account<'info, CampaignEscrow>,
}

#[derive(Accounts)]
pub struct BrandAction<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,
    #[account(mut, has_one = brand)]
    pub escrow: Account<'info, CampaignEscrow>,
}

#[derive(Accounts)]
pub struct ApproveAndRelease<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,
    /// CHECK: Checked against escrow.creator.
    #[account(mut)]
    pub creator: AccountInfo<'info>,
    #[account(mut, has_one = brand)]
    pub escrow: Account<'info, CampaignEscrow>,
}

#[derive(Accounts)]
pub struct RefundAfterDeadline<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,
    #[account(mut, has_one = brand)]
    pub escrow: Account<'info, CampaignEscrow>,
}

#[account]
#[derive(InitSpace)]
pub struct CampaignEscrow {
    pub brand: Pubkey,
    pub creator: Pubkey,
    pub amount_lamports: u64,
    pub brief_hash: [u8; 32],
    pub approval_deadline: i64,
    pub state: CampaignState,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CampaignState {
    Funded,
    Delivered,
    Released,
    Refunded,
    Disputed,
}

#[event]
pub struct CampaignOpened {
    pub escrow: Pubkey,
    pub brand: Pubkey,
    pub creator: Pubkey,
    pub amount_lamports: u64,
    pub brief_hash: [u8; 32],
}

#[event]
pub struct CampaignDelivered {
    pub escrow: Pubkey,
}

#[event]
pub struct CampaignReleased {
    pub escrow: Pubkey,
    pub creator: Pubkey,
}

#[event]
pub struct CampaignRefunded {
    pub escrow: Pubkey,
    pub brand: Pubkey,
}

#[event]
pub struct CampaignDisputed {
    pub escrow: Pubkey,
}

#[error_code]
pub enum LunaEscrowError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Approval deadline must be in the future.")]
    InvalidDeadline,
    #[msg("This action is not allowed for the signer.")]
    Unauthorized,
    #[msg("Escrow is not in the expected state.")]
    InvalidState,
    #[msg("The approval deadline has not been reached.")]
    DeadlineNotReached,
}

